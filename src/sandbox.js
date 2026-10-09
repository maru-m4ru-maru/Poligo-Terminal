import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import pty from 'node-pty'

const bwrapPath = '/usr/bin/bwrap'
const sandboxLauncherPath = '/app/bin/poligo-sandbox-launcher'
const workspaceRoot = process.env.TERMINAL_RUN_ROOT || '/tmp/poligo-terminal-sessions'
const maxFiles = Number(process.env.TERMINAL_MAX_FILES || 200)
const maxProjectBytes = Number(process.env.TERMINAL_MAX_PROJECT_BYTES || 5_000_000)
const maxWorkspaceBytes = Number(process.env.TERMINAL_MAX_WORKSPACE_BYTES || 384 * 1024 * 1024)
const maxWorkspaceEntries = Number(process.env.TERMINAL_MAX_WORKSPACE_ENTRIES || 20_000)
const maxOutputBytes = Number(process.env.TERMINAL_MAX_OUTPUT_BYTES || 65_536)
const maxSessions = Number(process.env.TERMINAL_MAX_SESSIONS || 4)
const idleTtlMs = Number(process.env.TERMINAL_IDLE_TTL_MS || 30 * 60 * 1000)
const maxLifetimeMs = Number(process.env.TERMINAL_MAX_LIFETIME_MS || 4 * 60 * 60 * 1000)
const sandboxUid = 65534
const maxSocketBufferBytes = 1_048_576
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.terminal-cache',
  '.tmp',
  '.cache'
])

const sessions = new Map()
let pendingCreates = 0
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

function sandboxArguments(workspace, uid) {
  const args = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--uid',
    String(uid),
    '--gid',
    String(uid),
    '--hostname',
    'poligo-terminal',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/sbin',
    '/sbin'
  ]

  if (existsSync('/usr/lib')) {
    args.push('--symlink', 'usr/lib', '/lib')
  }

  if (existsSync('/usr/lib64')) {
    args.push('--symlink', 'usr/lib64', '/lib64')
  }

  args.push(
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--dir',
    '/tmp',
    '--bind',
    path.join(workspace, '.terminal-cache', 'tmp'),
    '/tmp',
    '--dir',
    '/workspace',
    '--bind',
    workspace,
    '/workspace',
    '--dir',
    '/run',
    '--dir',
    '/home',
    '--chdir',
    '/workspace',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv',
    'HOME',
    '/workspace',
    '--setenv',
    'USER',
    'poligo',
    '--setenv',
    'LOGNAME',
    'poligo',
    '--setenv',
    'SHELL',
    '/bin/bash',
    '--setenv',
    'TERM',
    'xterm-256color',
    '--setenv',
    'COLORTERM',
    'truecolor',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'LC_ALL',
    'C.UTF-8',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'NPM_CONFIG_CACHE',
    '/workspace/.terminal-cache/npm',
    '--setenv',
    'XDG_CACHE_HOME',
    '/workspace/.terminal-cache',
    '--setenv',
    'PS1',
    '\\u@poligo:\\w\\$ ',
    '--cap-drop',
    'ALL'
  )

  return args
}


async function makeWorkspace(id, files) {
  const workspace = path.join(workspaceRoot, id)
  await fs.mkdir(workspace, {
    recursive: true,
    mode: 0o700
  })
  await fs.chmod(workspace, 0o700)

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

  await setWorkspaceOwnership(workspace)

  return workspace
}

async function setWorkspaceOwnership(workspace) {
  const entries = await fs.readdir(workspace, {
    withFileTypes: true
  })

  for (const entry of entries) {
    const target = path.join(workspace, entry.name)

    if (entry.isDirectory()) {
      await setWorkspaceOwnership(target)
      await fs.chown(target, sandboxUid, sandboxUid)
      continue
    }

    if (entry.isFile()) {
      await fs.chown(target, sandboxUid, sandboxUid)
    }
  }

  await fs.chown(workspace, sandboxUid, sandboxUid)
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

      if (stat.size === 0) {
        files[relative] = ''
        continue
      }

      const content = await fs.readFile(fullPath)

      if (content.includes(0)) {
        continue
      }

      files[relative] = content.toString('utf8')
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
    '--cpu=120:120',
    '--as=536870912:536870912',
    '--nproc=64:64',
    '--nofile=256:256',
    '--fsize=104857600:104857600',
    '--',
    sandboxLauncherPath,
    bwrapPath,
    ...sandboxArguments(session.workspace, sandboxUid),
    '--',
    '/bin/bash',
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
      HOME: session.workspace,
      TMPDIR: path.join(session.workspace, '.terminal-cache', 'tmp'),
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

export async function initializeSandbox() {
  if (process.getuid?.() !== 0) {
    sandboxStatus = {
      ready: false,
      reason: 'runner must start as root to initialize isolated workspaces'
    }
    return sandboxStatus
  }

  if (!existsSync(bwrapPath)) {
    sandboxStatus = {
      ready: false,
      reason: 'bubblewrap is not installed'
    }
    return sandboxStatus
  }

  const probeId = 'sandbox-probe-' + randomUUID()
  const probeWorkspace = path.join(workspaceRoot, probeId)

  try {
    await fs.mkdir(path.join(probeWorkspace, '.terminal-cache', 'tmp'), {
      recursive: true,
      mode: 0o700
    })
    await setWorkspaceOwnership(probeWorkspace)

    const result = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/prlimit', [
        '--cpu=5:5',
        '--as=268435456:268435456',
        '--nproc=16:16',
        '--nofile=128:128',
        '--',
        sandboxLauncherPath,
        bwrapPath,
        ...sandboxArguments(probeWorkspace, sandboxUid),
        '--',
        '/usr/bin/id',
        '-u'
      ], {
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
      }, 8_000)

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

    if (result.code !== 0) {
      throw new Error([
        'bubblewrap probe failed',
        'exit=' + result.code,
        result.signal ? 'signal=' + result.signal : '',
        result.stderr.trim(),
        result.stdout.trim()
      ].filter(Boolean).join(' | ').slice(0, 600))
    }

    if (result.stdout.trim() !== String(sandboxUid)) {
      throw new Error('isolated user namespace returned an unexpected uid: ' + result.stdout.trim())
    }

    sandboxStatus = {
      ready: true,
      reason: ''
    }
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString('utf8')
      : String(error?.stderr || '')
    const stdout = Buffer.isBuffer(error?.stdout)
      ? error.stdout.toString('utf8')
      : String(error?.stdout || '')
    const details = [
      error instanceof Error ? error.message : '',
      error?.code ? 'code=' + error.code : '',
      error?.signal ? 'signal=' + error.signal : '',
      stderr.trim(),
      stdout.trim()
    ].filter(Boolean).join(' | ').slice(0, 600)

    sandboxStatus = {
      ready: false,
      reason: details || 'bubblewrap namespace probe failed'
    }
  } finally {
    await fs.rm(probeWorkspace, {
      recursive: true,
      force: true
    }).catch(() => {})
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
    type: 'bubblewrap-user-pid-mount-namespaces-seccomp-network-deny',
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
  let workspace

  try {
    await fs.mkdir(workspaceRoot, {
      recursive: true,
      mode: 0o711
    })
    await fs.chmod(workspaceRoot, 0o711)

    workspace = await makeWorkspace(terminalId, normalized)

    const session = {
      id: terminalId,
      workspace,
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
      await fs.rm(workspace, {
        recursive: true,
        force: true
      })
      throw error
    }

    return {
      id: terminalId,
      createdAt: new Date(session.createdAt).toISOString()
    }
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
  sessions.delete(terminalId)

  if (session.socket?.readyState === 1) {
    session.socket.close(1000, 'terminal session closed')
  }

  try {
    session.terminal?.kill('SIGKILL')
  } catch {}

  await fs.rm(session.workspace, {
    recursive: true,
    force: true
  })
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
}, 15_000)

cleanupTimer.unref?.()
