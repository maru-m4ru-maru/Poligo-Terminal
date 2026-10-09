import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import pty from 'node-pty'

const execFileAsync = promisify(execFile)
const launcherPath = '/app/bin/poligo-chroot-launcher'
const rootfsBase = '/opt/poligo/rootfs'
const workspaceRoot = process.env.TERMINAL_RUN_ROOT || '/tmp/poligo-terminal-sessions'
const maxFiles = Number(process.env.TERMINAL_MAX_FILES || 200)
const maxProjectBytes = Number(process.env.TERMINAL_MAX_PROJECT_BYTES || 5_000_000)
const maxWorkspaceBytes = Number(process.env.TERMINAL_MAX_WORKSPACE_BYTES || 134_217_728)
const maxWorkspaceEntries = Number(process.env.TERMINAL_MAX_WORKSPACE_ENTRIES || 5_000)
const maxOutputBytes = Number(process.env.TERMINAL_MAX_OUTPUT_BYTES || 65_536)
const maxSessions = Number(process.env.TERMINAL_MAX_SESSIONS || 2)
const idleTtlMs = Number(process.env.TERMINAL_IDLE_TTL_MS || 30 * 60 * 1000)
const maxLifetimeMs = Number(process.env.TERMINAL_MAX_LIFETIME_MS || 60 * 60 * 1000)
const maxSocketBufferBytes = 1_048_576
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.terminal-cache',
  '.tmp',
  '.cache'
])

const sessions = new Map()
const reservedUids = new Set()
let pendingCreates = 0
let nextUid = 20_000
let sandboxStatus = {
  ready: false,
  reason: 'sandbox has not been initialized'
}

function normalizeId(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value)
  ) {
    throw new Error('invalid terminal id')
  }

  return value
}

function normalizeFilePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 240 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.includes('\\')
  ) {
    throw new Error('invalid file path')
  }

  const parts = value.split('/')

  if (
    parts.some(part =>
      !part ||
      part === '.' ||
      part === '..' ||
      ignoredDirectories.has(part)
    )
  ) {
    throw new Error('invalid file path')
  }

  return parts.join('/')
}

function normalizeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('terminal files must be an object')
  }

  const entries = Object.entries(files)

  if (!entries.length) {
    throw new Error('terminal workspace is empty')
  }

  if (entries.length > maxFiles) {
    throw new Error('too many terminal files')
  }

  let totalBytes = 0
  const normalized = {}

  for (const [name, content] of entries) {
    const safePath = normalizeFilePath(name)

    if (typeof content !== 'string') {
      throw new Error('terminal file content must be text')
    }

    totalBytes += Buffer.byteLength(content, 'utf8')

    if (totalBytes > maxProjectBytes) {
      throw new Error('terminal workspace is too large')
    }

    normalized[safePath] = content
  }

  return normalized
}

function allocateUid() {
  for (let attempt = 0; attempt < 40_000; attempt += 1) {
    const uid = nextUid
    nextUid += 1

    if (nextUid > 59_999) {
      nextUid = 20_000
    }

    if (reservedUids.has(uid)) {
      continue
    }

    reservedUids.add(uid)
    return uid
  }

  throw new Error('terminal user pool is exhausted')
}

async function setWorkspaceOwnership(directory, uid) {
  const entries = await fs.readdir(directory, {
    withFileTypes: true
  })

  for (const entry of entries) {
    const target = path.join(directory, entry.name)

    if (entry.isSymbolicLink()) {
      continue
    }

    if (entry.isDirectory()) {
      await setWorkspaceOwnership(target, uid)
      await fs.chown(target, uid, uid)
      continue
    }

    if (entry.isFile()) {
      await fs.chown(target, uid, uid)
    }
  }

  await fs.chown(directory, uid, uid)
}

async function writeSessionAccountFile(rootfs, filename, line) {
  const baseFile = path.join(rootfsBase, 'etc', filename)
  const targetFile = path.join(rootfs, 'etc', filename)

  await fs.unlink(targetFile)
  await fs.copyFile(baseFile, targetFile)
  await fs.appendFile(targetFile, line, 'utf8')
  await fs.chmod(targetFile, 0o444)
}

async function ensureSandboxDeviceNodes() {
  const devDirectory = path.join(rootfsBase, 'dev')
  const devices = [
    { name: 'null', major: 1, minor: 3 },
    { name: 'zero', major: 1, minor: 5 },
    { name: 'full', major: 1, minor: 7 },
    { name: 'random', major: 1, minor: 8 },
    { name: 'urandom', major: 1, minor: 9 },
    { name: 'tty', major: 5, minor: 0 }
  ]

  try {
    await fs.chmod(devDirectory, 0o755)

    for (const device of devices) {
      const filename = path.join(devDirectory, device.name)
      let stat = null

      try {
        stat = await fs.lstat(filename)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
      }

      if (stat && !stat.isCharacterDevice()) {
        throw new Error('invalid sandbox device node: ' + device.name)
      }

      if (!stat) {
        await execFileAsync('/usr/bin/mknod', [
          '-m',
          '666',
          filename,
          'c',
          String(device.major),
          String(device.minor)
        ], {
          timeout: 5_000,
          maxBuffer: 4_096
        })
      }

      await fs.chmod(filename, 0o666)
    }
  } finally {
    await fs.chmod(devDirectory, 0o555).catch(() => {})
  }
}

async function createSessionFilesystem(id, uid, files) {
  const rootfs = path.join(workspaceRoot, id)
  await fs.mkdir(rootfs, {
    recursive: false,
    mode: 0o700
  })

  try {
    const rootEntries = await fs.readdir(rootfsBase)

    for (const entry of rootEntries) {
      await execFileAsync('/bin/cp', [
        '-al',
        path.join(rootfsBase, entry),
        rootfs
      ], {
        timeout: 15_000,
        maxBuffer: 65_536
      })
    }

    for (const required of ['etc', 'usr', 'bin', 'workspace', 'tmp', 'dev']) {
      const target = path.join(rootfs, required)
      const stat = await fs.lstat(target).catch(() => null)

      if (!stat) {
        throw new Error('missing chroot root entry: ' + required)
      }
    }

    const username = 'poligo' + uid
    await fs.chmod(path.join(rootfs, 'etc'), 0o755)
    await writeSessionAccountFile(
      rootfs,
      'passwd',
      username + ':x:' + uid + ':' + uid + ':Poligo Terminal:/workspace:/usr/bin/bash\n'
    )
    await writeSessionAccountFile(
      rootfs,
      'group',
      username + ':x:' + uid + ':\n'
    )

    const workspace = path.join(rootfs, 'workspace')
    await fs.chmod(workspace, 0o700)
    await fs.chown(workspace, uid, uid)
    await fs.mkdir(path.join(workspace, '.terminal-cache', 'tmp'), {
      recursive: true,
      mode: 0o700
    })

    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(workspace, name)
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700
      })
      await fs.writeFile(destination, content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
    }

    await setWorkspaceOwnership(workspace, uid)
    await fs.chmod(rootfs, 0o755)

    return {
      rootfs,
      workspace,
      username
    }
  } catch (error) {
    await fs.rm(rootfs, {
      recursive: true,
      force: true
    }).catch(() => {})
    throw error
  }
}

async function walkWorkspace(workspace, includeFiles) {
  const files = {}
  const pending = [workspace]
  let entries = 0
  let totalBytes = 0

  while (pending.length) {
    const current = pending.pop()
    const children = await fs.readdir(current, {
      withFileTypes: true
    })

    for (const child of children) {
      entries += 1

      if (entries > maxWorkspaceEntries) {
        throw new Error('terminal workspace contains too many files')
      }

      const fullPath = path.join(current, child.name)
      const relative = path.relative(workspace, fullPath).split(path.sep).join('/')

      if (child.isSymbolicLink()) {
        continue
      }

      if (child.isDirectory()) {
        pending.push(fullPath)
        continue
      }

      if (!child.isFile()) {
        continue
      }

      const stat = await fs.stat(fullPath)
      totalBytes += stat.size

      if (totalBytes > maxWorkspaceBytes) {
        throw new Error('terminal workspace storage limit exceeded')
      }

      if (!includeFiles || relative.split('/').some(part => ignoredDirectories.has(part))) {
        continue
      }

      if (stat.size > maxProjectBytes || Object.keys(files).length >= maxFiles) {
        throw new Error('terminal project files exceed the sync limit')
      }

      let safePath

      try {
        safePath = normalizeFilePath(relative)
      } catch {
        continue
      }

      if (stat.size === 0) {
        files[safePath] = ''
        continue
      }

      const content = await fs.readFile(fullPath)

      if (content.includes(0)) {
        continue
      }

      files[safePath] = content.toString('utf8')
    }
  }

  return includeFiles ? files : {
    entries,
    bytes: totalBytes
  }
}

function appendOutput(session, data) {
  session.lastUsedAt = Date.now()
  session.outputBuffer += data

  if (session.outputBuffer.length > maxOutputBytes) {
    session.outputBuffer = session.outputBuffer.slice(-maxOutputBytes)
  }

  if (
    session.socket?.readyState === 1 &&
    session.socket.bufferedAmount < maxSocketBufferBytes
  ) {
    session.socket.send(JSON.stringify({
      type: 'output',
      data
    }))
  }
}

function createPty(session) {
  const limits = [
    '--cpu=60:60',
    '--as=4294967296:4294967296',
    '--nproc=64:64',
    '--nofile=128:128',
    '--fsize=52428800:52428800',
    '--core=0:0',
    '--',
    launcherPath,
    session.rootfs,
    String(session.uid),
    String(session.uid),
    '/usr/bin/bash',
    '--noprofile',
    '--norc',
    '-i'
  ]

  const terminal = pty.spawn('/usr/bin/prlimit', limits, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: session.workspace,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: '/workspace',
      USER: session.username,
      LOGNAME: session.username,
      SHELL: '/usr/bin/bash',
      PWD: '/workspace',
      TMPDIR: '/tmp',
      NPM_CONFIG_CACHE: '/workspace/.terminal-cache/npm',
      XDG_CACHE_HOME: '/workspace/.terminal-cache',
      PS1: '\\u@poligo:\\w\\$ '
    }
  })

  terminal.onData(data => {
    appendOutput(session, data)
  })

  terminal.onExit(({ exitCode, signal }) => {
    session.exitedAt = Date.now()
    appendOutput(
      session,
      '\r\n[terminal exited with code ' + exitCode + ', signal ' + signal + ']\r\n'
    )

    if (session.socket?.readyState === 1) {
      session.socket.close(1000, 'terminal process exited')
    }
  })

  return terminal
}

function runProbe(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      if (stdout.length < 4_096) {
        stdout += chunk.toString('utf8').slice(0, 4_096 - stdout.length)
      }
    })

    child.stderr.on('data', chunk => {
      if (stderr.length < 4_096) {
        stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length)
      }
    })

    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout,
        stderr
      })
    })
  })
}

async function runSandboxProbe(rootfs, uid) {
  const limits = [
    '--cpu=5:5',
    '--as=4294967296:4294967296',
    '--nproc=16:16',
    '--nofile=128:128',
    '--core=0:0',
    '--',
    launcherPath,
    rootfs,
    String(uid),
    String(uid)
  ]

  const identity = await runProbe('/usr/bin/prlimit', [
    ...limits,
    '/usr/bin/id',
    '-u'
  ], 8_000)

  if (identity.code !== 0 || identity.stdout.trim() !== String(uid)) {
    throw new Error([
      'chroot privilege-drop probe failed',
      'exit=' + identity.code,
      identity.signal ? 'signal=' + identity.signal : '',
      identity.stderr.trim(),
      identity.stdout.trim()
    ].filter(Boolean).join(' | ').slice(0, 600))
  }

  const network = await runProbe('/usr/bin/prlimit', [
    ...limits,
    '/usr/bin/python3',
    '-c',
    'import socket; socket.socket()'
  ], 8_000)

  if (
    network.code === 0 ||
    !network.stderr.includes('PermissionError')
  ) {
    throw new Error([
      'seccomp network-denial probe failed',
      'exit=' + network.code,
      network.signal ? 'signal=' + network.signal : '',
      network.stderr.trim(),
      network.stdout.trim()
    ].filter(Boolean).join(' | ').slice(0, 600))
  }
}

export async function initializeSandbox() {
  if (process.getuid?.() !== 0) {
    sandboxStatus = {
      ready: false,
      reason: 'runner must start as root to initialize isolated workspaces'
    }
    return sandboxStatus
  }

  if (
    !existsSync(launcherPath) ||
    !existsSync(path.join(rootfsBase, 'usr', 'bin', 'bash')) ||
    !existsSync(path.join(rootfsBase, 'usr', 'bin', 'python3')) ||
    !existsSync(path.join(rootfsBase, 'workspace')) ||
    !existsSync('/usr/bin/prlimit') ||
    !existsSync('/usr/bin/pkill')
  ) {
    sandboxStatus = {
      ready: false,
      reason: 'chroot runtime or launcher is not installed'
    }
    return sandboxStatus
  }

  try {
    await ensureSandboxDeviceNodes()
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 600)

    sandboxStatus = {
      ready: false,
      reason: 'sandbox device initialization failed: ' + reason
    }

    console.error('Terminal sandbox device setup failed', {
      reason
    })

    return sandboxStatus
  }

  const probeId = 'sandbox-probe-' + randomUUID()
  const probeUid = 30001
  let probeRootfs = ''

  try {
    await fs.mkdir(workspaceRoot, {
      recursive: true,
      mode: 0o711
    })
    await fs.chmod(workspaceRoot, 0o711)

    const created = await createSessionFilesystem(probeId, probeUid, {
      'probe.txt': 'probe\n'
    })
    probeRootfs = created.rootfs

    await runSandboxProbe(probeRootfs, probeUid)

    sandboxStatus = {
      ready: true,
      reason: ''
    }
  } catch (error) {
    const details = [
      error instanceof Error ? error.message : String(error)
    ].filter(Boolean).join(' | ').slice(0, 600)

    sandboxStatus = {
      ready: false,
      reason: details || 'chroot sandbox probe failed'
    }
  } finally {
    if (probeRootfs) {
      await fs.rm(probeRootfs, {
        recursive: true,
        force: true
      }).catch(() => {})
    }
  }

  if (!sandboxStatus.ready) {
    console.error('Terminal sandbox unavailable; shell creation will fail closed', {
      reason: sandboxStatus.reason
    })
  }

  return sandboxStatus
}

export function getSandboxStatus() {
  return {
    ready: sandboxStatus.ready,
    type: 'chroot-unique-uid-seccomp-network-deny',
    reason: sandboxStatus.reason
  }
}

export async function createTerminalSession({ id = randomUUID(), files }) {
  if (!sandboxStatus.ready) {
    throw new Error('secure terminal sandbox is unavailable')
  }

  if (sessions.size + pendingCreates >= maxSessions) {
    throw new Error('terminal capacity is currently full')
  }

  const terminalId = normalizeId(id)
  const normalized = normalizeFiles(files)

  if (sessions.has(terminalId)) {
    throw new Error('terminal id already exists')
  }

  pendingCreates += 1
  const uid = allocateUid()
  let rootfs = ''

  try {
    const created = await createSessionFilesystem(terminalId, uid, normalized)
    rootfs = created.rootfs

    const session = {
      id: terminalId,
      uid,
      username: created.username,
      rootfs,
      workspace: created.workspace,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      exitedAt: null,
      outputBuffer: '',
      socket: null,
      terminal: null,
      closing: false
    }

    sessions.set(terminalId, session)

    try {
      session.terminal = createPty(session)
    } catch (error) {
      sessions.delete(terminalId)
      await cleanupSession(session)
      throw error
    }

    return {
      id: terminalId,
      createdAt: new Date(session.createdAt).toISOString()
    }
  } catch (error) {
    if (rootfs) {
      await fs.rm(rootfs, {
        recursive: true,
        force: true
      }).catch(() => {})
    }

    reservedUids.delete(uid)
    throw error
  } finally {
    pendingCreates -= 1
  }
}

export async function getTerminalFiles(id) {
  const terminalId = normalizeId(id)
  const session = sessions.get(terminalId)

  if (!session || session.closing) {
    throw new Error('terminal session not found')
  }

  session.lastUsedAt = Date.now()
  return await walkWorkspace(session.workspace, true)
}

async function killUserProcesses(session) {
  try {
    await execFileAsync('/usr/bin/pkill', [
      '-KILL',
      '-u',
      String(session.uid)
    ], {
      timeout: 5_000,
      maxBuffer: 4_096
    })
  } catch {}
}

async function cleanupSession(session) {
  if (session.cleanupStarted) {
    return
  }

  session.cleanupStarted = true

  if (session.socket?.readyState === 1) {
    session.socket.close(1000, 'terminal session closed')
  }

  try {
    session.terminal?.kill('SIGKILL')
  } catch {}

  await killUserProcesses(session)
  sessions.delete(session.id)

  await fs.rm(session.rootfs, {
    recursive: true,
    force: true
  }).catch(() => {})

  reservedUids.delete(session.uid)
}

export async function closeTerminal(id) {
  const terminalId = normalizeId(id)
  const session = sessions.get(terminalId)

  if (!session) {
    throw new Error('terminal session not found')
  }

  if (session.closing) {
    return
  }

  session.closing = true
  await cleanupSession(session)
}

export function attachTerminalSocket(id, socket) {
  const terminalId = normalizeId(id)
  const session = sessions.get(terminalId)

  if (!session || session.closing) {
    throw new Error('terminal session not found')
  }

  if (session.socket && session.socket.readyState === 1) {
    session.socket.close(4000, 'terminal socket replaced')
  }

  session.socket = socket
  session.lastUsedAt = Date.now()

  if (session.outputBuffer) {
    socket.send(JSON.stringify({
      type: 'output',
      data: session.outputBuffer
    }))
  }

  socket.on('message', raw => {
    session.lastUsedAt = Date.now()

    if (!session.terminal || session.exitedAt) {
      return
    }

    let payload

    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }

    if (
      payload?.type === 'input' &&
      typeof payload.data === 'string' &&
      Buffer.byteLength(payload.data, 'utf8') <= 16_384
    ) {
      session.terminal.write(payload.data)
      return
    }

    if (payload?.type === 'resize') {
      const cols = Number(payload.cols)
      const rows = Number(payload.rows)

      if (
        Number.isInteger(cols) &&
        Number.isInteger(rows) &&
        cols >= 20 &&
        cols <= 240 &&
        rows >= 5 &&
        rows <= 100
      ) {
        session.terminal.resize(cols, rows)
      }
    }
  })

  socket.on('close', () => {
    if (session.socket === socket) {
      session.socket = null
    }
  })

  socket.on('error', () => {
    if (session.socket === socket) {
      session.socket = null
    }
  })
}

const cleanupTimer = setInterval(() => {
  const now = Date.now()

  for (const session of sessions.values()) {
    if (
      now - session.lastUsedAt >= idleTtlMs ||
      now - session.createdAt >= maxLifetimeMs
    ) {
      void closeTerminal(session.id).catch(error => {
        console.error('Terminal cleanup failed', {
          id: session.id,
          message: error instanceof Error ? error.message : String(error)
        })
      })
      continue
    }

    void walkWorkspace(session.workspace, false).catch(error => {
      appendOutput(
        session,
        '\r\n[terminal stopped] ' +
          (error instanceof Error ? error.message : 'workspace limit exceeded') +
          '\r\n'
      )
      void closeTerminal(session.id).catch(() => {})
    })
  }
}, 5_000)

cleanupTimer.unref?.()
