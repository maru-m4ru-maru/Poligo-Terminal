import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import {
  attachTerminalSocket,
  closeTerminal,
  createTerminalSession,
  getSandboxStatus,
  getTerminalFiles,
  initializeSandbox
} from './sandbox.js'

const port = Number(process.env.PORT || 10000)
const runnerToken = process.env.RUNNER_TOKEN || ''
const maxRequestBytes = Number(process.env.MAX_REQUEST_BYTES || 8_000_000)
const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 32_768,
  perMessageDeflate: false
})

function send(response, status, body) {
  if (response.headersSent) {
    response.destroy()
    return
  }

  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length

    if (size > maxRequestBytes) {
      const error = new Error('request too large')
      error.statusCode = 413
      throw error
    }

    chunks.push(Buffer.from(chunk))
  }

  if (!size) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid JSON body')
    error.statusCode = 400
    throw error
  }
}

function authorized(request) {
  if (!runnerToken) {
    return false
  }

  const supplied = request.headers.authorization || ''
  const expected = 'Bearer ' + runnerToken
  const suppliedBuffer = Buffer.from(supplied)
  const expectedBuffer = Buffer.from(expected)

  return suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
}

function terminalIdFromPath(pathname, suffix = '') {
  const prefix = '/v1/terminals/'
  const raw = pathname.slice(prefix.length, suffix ? -suffix.length : undefined)

  if (!raw || raw.includes('/')) {
    return ''
  }

  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

const server = http.createServer({
  maxHeaderSize: 16_384,
  requestTimeout: 20_000,
  headersTimeout: 10_000,
  keepAliveTimeout: 5_000
}, async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost')

  if (request.method === 'GET' && url.pathname === '/health') {
    const sandbox = getSandboxStatus()
    const ready = Boolean(runnerToken) && sandbox.ready

    send(response, 200, {
      status: ready ? 'ok' : 'degraded',
      service: 'poligo-terminal-runner',
      terminalBackend: sandbox.type,
      terminalReady: ready,
      tokenConfigured: Boolean(runnerToken),
      sandboxReason: sandbox.ready ? undefined : sandbox.reason
    })
    return
  }

  if (!authorized(request)) {
    send(response, 401, {
      error: 'unauthorized'
    })
    return
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/v1/terminals'
  ) {
    try {
      const payload = await readJson(request)
      const session = await createTerminalSession(payload)
      send(response, 202, session)
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'invalid terminal request'
      const status = error?.statusCode ||
        (message.includes('capacity is currently full')
          ? 429
          : message.includes('secure terminal sandbox is unavailable')
            ? 503
            : message.includes('too large') || message.includes('too many')
              ? 413
              : message.includes('already exists')
                ? 409
                : 400)

      send(response, status, {
        error: message
      })
    }
    return
  }

  if (
    request.method === 'GET' &&
    url.pathname.startsWith('/v1/terminals/') &&
    url.pathname.endsWith('/files')
  ) {
    const id = terminalIdFromPath(url.pathname, '/files')

    try {
      const files = await getTerminalFiles(id)
      send(response, 200, {
        files
      })
    } catch (error) {
      send(response, 404, {
        error: error instanceof Error
          ? error.message
          : 'terminal session not found'
      })
    }
    return
  }

  if (
    request.method === 'DELETE' &&
    url.pathname.startsWith('/v1/terminals/')
  ) {
    const id = terminalIdFromPath(url.pathname)

    try {
      await closeTerminal(id)
      send(response, 200, {
        ok: true
      })
    } catch (error) {
      send(response, 404, {
        error: error instanceof Error
          ? error.message
          : 'terminal session not found'
      })
    }
    return
  }

  send(response, 404, {
    error: 'not found'
  })
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost')
  const prefix = '/v1/terminals/'

  if (!url.pathname.startsWith(prefix)) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }

  if (!authorized(request)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }

  const id = terminalIdFromPath(url.pathname)

  if (!id) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return
  }

  websocketServer.handleUpgrade(request, socket, head, client => {
    try {
      attachTerminalSocket(id, client)
    } catch {
      client.close(4404, 'terminal session not found')
    }
  })
})

async function start() {
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(process.env.TERMINAL_RUN_ROOT || '/tmp/poligo-terminal-sessions', {
      recursive: true,
      mode: 0o711
    })
  )

  await initializeSandbox()

  server.listen(port, '0.0.0.0', () => {
    const sandbox = getSandboxStatus()
    console.info('Poligo Terminal Runner listening', {
      port,
      sandboxReady: sandbox.ready,
      sandboxType: sandbox.type,
      tokenConfigured: Boolean(runnerToken)
    })
  })
}

start().catch(error => {
  console.error('Poligo Terminal Runner startup failed', {
    message: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 1
})
