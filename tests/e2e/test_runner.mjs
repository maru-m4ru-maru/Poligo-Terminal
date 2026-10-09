import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const token = process.env.RUNNER_TEST_TOKEN || 'terminal-process-e2e-token'
const baseUrl = process.env.RUNNER_TEST_URL || 'http://127.0.0.1:10000'
const firstId = randomUUID()
const secondId = randomUUID()
const sockets = new Set()
const createdIds = []

function request(path, method = 'GET', body, authToken = token) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    const headers = {
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
      ...(serialized === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(serialized)
      })
    }

    const outgoing = http.request(baseUrl + path, {
      method,
      headers,
      timeout: 15_000
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null

        try {
          json = text ? JSON.parse(text) : null
        } catch {}

        resolve({
          status: response.statusCode || 0,
          body: json,
          text
        })
      })
    })

    outgoing.on('timeout', () => outgoing.destroy(new Error('request timeout: ' + path)))
    outgoing.on('error', reject)

    if (serialized !== undefined) {
      outgoing.write(serialized)
    }

    outgoing.end()
  })
}

function openSocket(id) {
  const socket = new WebSocket(
    baseUrl.replace(/^http/, 'ws') + '/v1/terminals/' + encodeURIComponent(id),
    {
      headers: {
        Authorization: 'Bearer ' + token
      },
      maxPayload: 32_768
    }
  )

  sockets.add(socket)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate()
      reject(new Error('websocket open timeout'))
    }, 15_000)

    socket.once('open', () => {
      clearTimeout(timeout)
      resolve(socket)
    })

    socket.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function outputLine(marker) {
  return output => output.split(/\r?\n/).some(line => line.trim() === marker)
}

function sendAndWait(socket, data, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = ''

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('terminal output timeout: ' + output))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }

    function onMessage(message) {
      let payload

      try {
        payload = JSON.parse(message.toString('utf8'))
      } catch {
        return
      }

      if (payload?.type === 'output') {
        output += payload.data || ''

        if (predicate(output)) {
          cleanup()
          resolve(output)
        }
      }

      if (payload?.type === 'error') {
        cleanup()
        reject(new Error(payload.message || 'terminal error'))
      }
    }

    function onClose() {
      cleanup()
      reject(new Error('terminal socket closed'))
    }

    function onError(error) {
      cleanup()
      reject(error)
    }

    socket.on('message', onMessage)
    socket.on('close', onClose)
    socket.on('error', onError)
    socket.send(JSON.stringify({
      type: 'input',
      data
    }))
  })
}

async function createSession(id, files) {
  const result = await request('/v1/terminals', 'POST', {
    id,
    files
  })

  assert.equal(result.status, 202, result.text)
  createdIds.push(id)
  return result.body
}

async function closeSession(id) {
  const socket = [...sockets].find(item => item.terminalId === id)

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close()
  }

  const result = await request('/v1/terminals/' + encodeURIComponent(id), 'DELETE')
  assert.equal(result.status, 200, result.text)

  const missing = await request('/v1/terminals/' + encodeURIComponent(id) + '/files')
  assert.equal(missing.status, 404)
}

async function run() {
  const health = await request('/health', 'GET', undefined, null)
  assert.equal(health.status, 200, health.text)
  assert.equal(health.body?.service, 'poligo-terminal-runner')
  assert.equal(health.body?.terminalReady, true, health.text)
  console.log('PASS sandbox readiness')

  const unauthenticated = await request('/v1/terminals', 'POST', {
    id: randomUUID(),
    files: {
      'main.js': 'console.log(1)'
    }
  }, null)
  assert.equal(unauthenticated.status, 401)

  const invalidPath = await request('/v1/terminals', 'POST', {
    id: randomUUID(),
    files: {
      '../escape.txt': 'unsafe'
    }
  })
  assert.equal(invalidPath.status, 400)
  console.log('PASS authentication and path validation')

  await createSession(firstId, {
    'main.js': 'console.log("initial file")\n',
    'private.txt': 'private session content\n'
  })

  const first = await openSocket(firstId)
  first.terminalId = firstId
  first.send(JSON.stringify({
    type: 'resize',
    cols: 100,
    rows: 30
  }))

  const prompt = await sendAndWait(
    first,
    "printf 'SHELL_READY\\n'\n",
    outputLine('SHELL_READY')
  )
  assert.ok(prompt.includes('SHELL_READY'))

  const pwd = await sendAndWait(
    first,
    "pwd\n",
    outputLine('/workspace')
  )
  assert.ok(pwd.includes('/workspace'))

  const uid = await sendAndWait(
    "id -u; if [ \"$(id -u)\" -gt 0 ] && [ \"$(id -u)\" -lt 60000 ]; then printf 'UNPRIVILEGED_UID_OK\\n'; fi\n",
    "id -u\n",
    outputLine('UNPRIVILEGED_UID_OK')
  )
  assert.ok(outputLine('UNPRIVILEGED_UID_OK')(uid))

  const hiddenSource = await sendAndWait(
    first,
    "test ! -e /app/src/server.js && printf 'RUNNER_SOURCE_HIDDEN\\n'\n",
    outputLine('RUNNER_SOURCE_HIDDEN')
  )
  assert.ok(hiddenSource.includes('RUNNER_SOURCE_HIDDEN'))

  const network = await sendAndWait(
    first,
    "if timeout 2 bash -c '</dev/tcp/1.1.1.1/443' 2>/dev/null; then printf 'NETWORK_NOT_ISOLATED\\n'; else printf 'NETWORK_ISOLATED\\n'; fi\n",
    output => outputLine('NETWORK_ISOLATED')(output) || outputLine('NETWORK_NOT_ISOLATED')(output),
    8_000
  )
  assert.ok(outputLine('NETWORK_ISOLATED')(network))
  assert.ok(!outputLine('NETWORK_NOT_ISOLATED')(network))
  console.log('PASS PTY, unprivileged UID, filesystem view, and network namespace')

  const node = await sendAndWait(
    first,
    "node -e \"console.log('NODE_RUNTIME_OK')\"\n",
    outputLine('NODE_RUNTIME_OK')
  )
  assert.ok(node.includes('NODE_RUNTIME_OK'))

  const python = await sendAndWait(
    first,
    "python3 -c \"print('PYTHON_RUNTIME_OK')\"\n",
    outputLine('PYTHON_RUNTIME_OK')
  )
  assert.ok(python.includes('PYTHON_RUNTIME_OK'))

  const stderr = await sendAndWait(
    first,
    "printf 'STDERR_CHANNEL_OK\\n' >&2\n",
    outputLine('STDERR_CHANNEL_OK')
  )
  assert.ok(stderr.includes('STDERR_CHANNEL_OK'))

  const writeFile = await sendAndWait(
    first,
    "mkdir -p generated && printf 'FILE_SYNC_OK\\n' > generated/output.txt && cat generated/output.txt\n",
    outputLine('FILE_SYNC_OK')
  )
  assert.ok(writeFile.includes('FILE_SYNC_OK'))

  const ignoredFile = await sendAndWait(
    first,
    "mkdir -p node_modules && printf 'IGNORE_ME' > node_modules/hidden.txt && printf 'IGNORE_READY\\n'\n",
    outputLine('IGNORE_READY')
  )
  assert.ok(ignoredFile.includes('IGNORE_READY'))

  const files = await request('/v1/terminals/' + encodeURIComponent(firstId) + '/files')
  assert.equal(files.status, 200, files.text)
  assert.equal(files.body?.files?.['generated/output.txt'], 'FILE_SYNC_OK\n')
  assert.equal('node_modules/hidden.txt' in files.body.files, false)
  console.log('PASS runtimes, stderr, output limits path, and project file synchronization')

  await createSession(secondId, {
    'second.txt': 'second session\n'
  })

  const second = await openSocket(secondId)
  second.terminalId = secondId

  const isolated = await sendAndWait(
    second,
    "if test -e /workspace/private.txt; then printf 'SESSION_NOT_ISOLATED\\n'; else printf 'SESSION_ISOLATED\\n'; fi\n",
    output => outputLine('SESSION_ISOLATED')(output) || outputLine('SESSION_NOT_ISOLATED')(output)
  )
  assert.ok(outputLine('SESSION_ISOLATED')(isolated))
  assert.ok(!outputLine('SESSION_NOT_ISOLATED')(isolated))

  const interrupted = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      first.off('message', onMessage)
      reject(new Error('Ctrl+C test timed out: ' + output))
    }, 12_000)

    function onMessage(message) {
      try {
        const payload = JSON.parse(message.toString('utf8'))
        if (payload.type === 'output') {
          output += payload.data || ''
        }
      } catch {}

      if (output.includes('^C')) {
        clearTimeout(timeout)
        first.off('message', onMessage)
        resolve(output)
      }
    }

    first.on('message', onMessage)
    first.send(JSON.stringify({
      type: 'input',
      data: 'sleep 15\n'
    }))

    setTimeout(() => {
      first.send(JSON.stringify({
        type: 'input',
        data: '\u0003'
      }))
    }, 300)
  })
  assert.ok(interrupted.includes('^C'))

  const updated = await sendAndWait(
    first,
    "printf 'UPDATED_VALUE\\n' >> generated/output.txt && cat generated/output.txt\n",
    output => outputLine('FILE_SYNC_OK')(output) && outputLine('UPDATED_VALUE')(output)
  )
  assert.ok(outputLine('FILE_SYNC_OK')(updated) && outputLine('UPDATED_VALUE')(updated))

  const finalFiles = await request('/v1/terminals/' + encodeURIComponent(firstId) + '/files')
  assert.equal(finalFiles.body?.files?.['generated/output.txt'], 'FILE_SYNC_OK\nUPDATED_VALUE\n')
  console.log('PASS session isolation, Ctrl+C, and persistent in-session file changes')

  await closeSession(secondId)
  await closeSession(firstId)
  console.log('TERMINAL RUNNER E2E: PASS')
}

try {
  await run()
} finally {
  for (const socket of sockets) {
    try {
      socket.terminate()
    } catch {}
  }

  for (const id of createdIds.reverse()) {
    try {
      await request('/v1/terminals/' + encodeURIComponent(id), 'DELETE')
    } catch {}
  }
}
