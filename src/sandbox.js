import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import pty from 'node-pty'

const execFileAsync = promisify(execFile)
const launcherPath = '/app/bin/poligo-chroot-launcher'
const rootfsBase = '/opt/poligo/rootfs'
const workspaceRoot = process.env.TERMINAL_RUN_ROOT || '/tmp/poligo-terminal-sessions'
const sandboxSlots = [
  {
    name: 'slot1',
    rootfs: '/opt/poligo/sandbox-slots/slot1',
    uid: 20001,
    username: 'poligo20001'
  },
  {
    name: 'slot2',
    rootfs: '/opt/poligo/sandbox-slots/slot2',
    uid: 20002,
    username: 'poligo20002'
  }
]
const maxFiles = Number(process.env.TERMINAL_MAX_FILES || 200)
const maxProjectBytes = Number(process.env.TERMINAL_MAX_PROJECT_BYTES || 5_000_000)
const maxWorkspaceBytes = Number(process.env.TERMINAL_MAX_WORKSPACE_BYTES || 134_217_728)
const maxWorkspaceEntries = Number(process.env.TERMINAL_MAX_WORKSPACE_ENTRIES || 5_000)
const maxOutputBytes = Number(process.env.TERMINAL_MAX_OUTPUT_BYTES || 65_536)
const maxSessions = Math.min(Number(process.env.TERMINAL_MAX_SESSIONS || 2), sandboxSlots.length)
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
const reservedSlots = new Set()
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

function normalizeFiles(files, allowEmpty = false) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('terminal files must be an object')
  }

  const entries = Object.entries(files)

  if (!entries.length && !allowEmpty) {
    throw new Error('terminal workspace is empty')
  }

  if (entries.length > maxFiles) {
    throw new Error('too many terminal files')
  }

  let totalBytes = 0
  const normalized = {}

  for (const [name, content] of entries) {
    const safePath = normalizeFilePath(name)

    if (Object.keys(normalized).some(existing =>
      existing.startsWith(safePath + '/') ||
      safePath.startsWith(existing + '/')
    )) {
      throw new Error('terminal file path conflicts with a directory')
    }

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

function allocateSlot() {
  const slot = sandboxSlots.find(candidate => !reservedSlots.has(candidate.name))

  if (!slot) {
    throw new Error('terminal capacity is currently full')
  }

  reservedSlots.add(slot.name)
  return slot
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

async function clearDirectory(directory) {
  await fs.mkdir(directory, {
    recursive: true
  })

  const entries = await fs.readdir(directory)

  for (const entry of entries) {
    await fs.rm(path.join(directory, entry), {
      recursive: true,
      force: true
    })
  }
}

async function resetSlotFilesystem(slot) {
  const workspace = path.join(slot.rootfs, 'workspace')
  const tempDirectories = [
    path.join(slot.rootfs, 'tmp'),
    path.join(slot.rootfs, 'var', 'tmp')
  ]

  await clearDirectory(workspace)
  await fs.chown(workspace, slot.uid, slot.uid)
  await fs.chmod(workspace, 0o700)

  for (const directory of tempDirectories) {
    await clearDirectory(directory)
    await fs.chmod(directory, 0o1777)
  }
}

async function createSessionFilesystem(slot, files) {
  const { rootfs, uid, username } = slot
  const workspace = path.join(rootfs, 'workspace')

  await resetSlotFilesystem(slot)
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

  return {
    rootfs,
    workspace,
    username,
    slot
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
    '/workspace',
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
    String(uid),
    '/workspace'
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
    sandboxSlots.some(slot =>
      !existsSync(path.join(slot.rootfs, 'usr', 'bin', 'bash')) ||
      !existsSync(path.join(slot.rootfs, 'usr', 'bin', 'python3')) ||
      !existsSync(path.join(slot.rootfs, 'workspace'))
    ) ||
    !existsSync('/usr/bin/prlimit') ||
    !existsSync('/usr/bin/pkill')
  ) {
    sandboxStatus = {
      ready: false,
      reason: 'chroot runtime or launcher is not installed'
    }
    return sandboxStatus
  }

  const probeSlot = sandboxSlots[0]

  try {
    await fs.mkdir(workspaceRoot, {
      recursive: true,
      mode: 0o711
    })
    await fs.chmod(workspaceRoot, 0o711)

    await createSessionFilesystem(probeSlot, {
      'probe.txt': 'probe\n'
    })

    await runSandboxProbe(probeSlot.rootfs, probeSlot.uid)

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
    await resetSlotFilesystem(probeSlot).catch(() => {})
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
  const slot = allocateSlot()
  const uid = slot.uid
  let rootfs = ''

  try {
    const created = await createSessionFilesystem(slot, normalized)
    rootfs = created.rootfs

    const session = {
      id: terminalId,
      uid,
      slot,
      username: created.username,
      rootfs,
      workspace: created.workspace,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      exitedAt: null,
      outputBuffer: '',
      socket: null,
      terminal: null,
      managedFiles: new Set(Object.keys(normalized)),
      fileSyncQueue: null,
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
    await resetSlotFilesystem(slot).catch(() => {})
    reservedSlots.delete(slot.name)
    throw error
  } finally {
    pendingCreates -= 1
  }
}

async function closeDirectoryHandles(handles) {
  for (const handle of handles.reverse()) {
    await handle.close().catch(() => {})
  }
}

async function withFileSyncLock(session, operation) {
  const previous = session.fileSyncQueue || Promise.resolve()
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => gate)

  session.fileSyncQueue = queued
  await previous.catch(() => {})

  try {
    if (session.closing) {
      throw new Error('terminal session not found')
    }

    return await operation()
  } finally {
    release()

    if (session.fileSyncQueue === queued) {
      session.fileSyncQueue = null
    }
  }
}

async function openDirectoryChain(session, directoryParts, create) {
  const flags = fsConstants.O_RDONLY |
    fsConstants.O_DIRECTORY |
    fsConstants.O_NOFOLLOW
  const handles = []

  try {
    let current = await fs.open(session.workspace, flags)
    handles.push(current)

    for (const part of directoryParts) {
      const target = '/proc/self/fd/' + current.fd + '/' + part
      let next

      while (!next) {
        try {
          next = await fs.open(target, flags)
        } catch (error) {
          if (error.code === 'ENOENT' && create) {
            await fs.mkdir(target, {
              mode: 0o700
            }).catch(mkdirError => {
              if (mkdirError.code !== 'EEXIST') {
                throw mkdirError
              }
            })
            continue
          }

          if (
            create &&
            (error.code === 'ELOOP' || error.code === 'ENOTDIR')
          ) {
            const stat = await fs.lstat(target).catch(() => null)

            if (stat?.isDirectory() && !stat.isSymbolicLink()) {
              continue
            }

            await fs.rm(target, {
              recursive: true,
              force: true
            })
            continue
          }

          if (
            !create &&
            ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)
          ) {
            await closeDirectoryHandles(handles)
            return null
          }

          throw error
        }
      }

      handles.push(next)
      current = next

      if (create) {
        await next.chown(session.uid, session.uid)
        await next.chmod(0o700)
      }
    }

    return {
      handle: current,
      handles
    }
  } catch (error) {
    await closeDirectoryHandles(handles)
    throw error
  }
}

async function removeEmptyParentDirectories(session, directoryParts) {
  for (let length = directoryParts.length; length > 0; length -= 1) {
    const parentParts = directoryParts.slice(0, length - 1)
    const directoryName = directoryParts[length - 1]
    const parent = await openDirectoryChain(session, parentParts, false)

    if (!parent) {
      return
    }

    try {
      const target = '/proc/self/fd/' + parent.handle.fd + '/' + directoryName
      await fs.rmdir(target)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
        return
      }

      throw error
    } finally {
      await closeDirectoryHandles(parent.handles)
    }
  }
}

async function removeManagedFile(session, relativePath) {
  const parts = relativePath.split('/')
  const name = parts.pop()
  const parent = await openDirectoryChain(session, parts, false)

  if (!parent) {
    await removeEmptyParentDirectories(session, parts)
    return
  }

  try {
    const target = '/proc/self/fd/' + parent.handle.fd + '/' + name
    const stat = await fs.lstat(target).catch(error => {
      if (error.code === 'ENOENT') {
        return null
      }

      throw error
    })

    if (stat && (stat.isFile() || stat.isSymbolicLink())) {
      await fs.rm(target, {
        force: true
      })
    }
  } finally {
    await closeDirectoryHandles(parent.handles)
  }

  await removeEmptyParentDirectories(session, parts)
}

async function writeManagedFile(session, relativePath, content) {
  const parts = relativePath.split('/')
  const name = parts.pop()
  const parent = await openDirectoryChain(session, parts, true)

  try {
    const destination = '/proc/self/fd/' + parent.handle.fd + '/' + name
    const existing = await fs.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') {
        return null
      }

      throw error
    })

    if (existing?.isDirectory() && !existing.isSymbolicLink()) {
      throw new Error('terminal path conflict: a file path is a directory')
    }

    if (existing?.isFile()) {
      try {
        const current = await fs.open(
          destination,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
        )

        try {
          const currentContent = await current.readFile()
          if (currentContent.toString('utf8') === content) {
            return
          }
        } finally {
          await current.close()
        }
      } catch (error) {
        if (!['ENOENT', 'ELOOP'].includes(error.code)) {
          throw error
        }
      }
    }

    const temporaryName = '.poligo-sync-' + randomUUID() + '.tmp'
    const temporary = '/proc/self/fd/' + parent.handle.fd + '/' + temporaryName
    let handle

    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600
      )
      await handle.writeFile(content, {
        encoding: 'utf8'
      })
      await handle.chown(session.uid, session.uid)
      await handle.chmod(0o600)
      await handle.close()
      handle = null
      await fs.rename(temporary, destination)
    } finally {
      if (handle) {
        await handle.close().catch(() => {})
      }

      await fs.rm(temporary, {
        force: true
      }).catch(() => {})
    }
  } finally {
    await closeDirectoryHandles(parent.handles)
  }
}

export async function getTerminalFiles(id) {
  const terminalId = normalizeId(id)
  const session = sessions.get(terminalId)

  if (!session || session.closing) {
    throw new Error('terminal session not found')
  }

  return withFileSyncLock(session, async () => {
    session.lastUsedAt = Date.now()
    const files = await walkWorkspace(session.workspace, true)
    session.managedFiles = new Set(Object.keys(files))
    return files
  })
}

export async function applyTerminalFiles(id, files) {
  const terminalId = normalizeId(id)
  const session = sessions.get(terminalId)

  if (!session || session.closing) {
    throw new Error('terminal session not found')
  }

  const normalized = normalizeFiles(files, true)

  return withFileSyncLock(session, async () => {
    for (const trackedPath of [...session.managedFiles]) {
      if (Object.prototype.hasOwnProperty.call(normalized, trackedPath)) {
        continue
      }

      await removeManagedFile(session, trackedPath)
      session.managedFiles.delete(trackedPath)
    }

    for (const [relativePath, content] of Object.entries(normalized)) {
      await writeManagedFile(session, relativePath, content)
      session.managedFiles.add(relativePath)
    }

    session.lastUsedAt = Date.now()

    return {
      fileCount: Object.keys(normalized).length
    }
  })
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

  if (session.fileSyncQueue) {
    await session.fileSyncQueue.catch(() => {})
  }

  sessions.delete(session.id)

  await resetSlotFilesystem(session.slot).catch(error => {
    console.error('Terminal slot cleanup failed', {
      id: session.id,
      message: error instanceof Error ? error.message : String(error)
    })
  })

  reservedSlots.delete(session.slot.name)
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
