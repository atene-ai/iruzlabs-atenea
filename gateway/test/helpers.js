// Fakes for the gateway's tests: Cognito (JWKS, token and revoke endpoints) and SLA behind an
// injected fetch, and a dsh web stand-in on a real port with the launch-token exchange, the
// owner cookie and a WebSocket echo. Nothing here talks to the network beyond loopback.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.js'

export const ISSUER = 'https://cognito-idp.mx-central-1.amazonaws.com/mx-central-1_testpool'
export const DOMAIN = 'https://atenea-test.auth.mx-central-1.amazoncognito.com'
export const CLIENT_ID = 'test-client-id'
export const PUBLIC_URL = 'https://ia.example.test'
export const PUBLIC_HOST = 'ia.example.test'
export const SLA_URL = 'https://sla.example.test'
export const IDENTITY_SECRET = 'test-identity-secret-0123456789abcdef'

export function createClock(start = Date.UTC(2026, 10, 4, 12)) {
  let at = start
  return { now: () => at, advance: (ms) => { at += ms } }
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

export function createKey(kid = randomBytes(6).toString('hex')) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } }
}

export function signRs256(header, claims, privateKey) {
  const signed = `${b64(header)}.${b64(claims)}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`
}

export function createCognito(clock) {
  const state = {
    keys: [createKey('key-1')],
    jwksFetches: 0,
    codes: new Map(),
    refreshTokens: new Map(),
    refreshCalls: 0,
    revoked: [],
    idTokenTtlS: 3600,
  }
  const signingKey = () => state.keys[state.keys.length - 1]

  state.idToken = (overrides = {}, key = signingKey()) => {
    const iat = Math.floor(clock.now() / 1000)
    const claims = {
      sub: 'cognito-sub-1',
      email: 'ana@example.com',
      email_verified: true,
      name: 'Ana Test',
      iss: ISSUER,
      aud: CLIENT_ID,
      token_use: 'id',
      iat,
      exp: iat + state.idTokenTtlS,
      ...overrides,
    }
    return signRs256({ alg: 'RS256', kid: key.kid }, claims, key.privateKey)
  }

  state.rotateKey = () => { state.keys.push(createKey(`key-${state.keys.length + 1}`)) }

  // What the Hosted UI would do after the user signs in: a code tied to the PKCE challenge.
  state.issueCode = ({ challenge, nonce, claims = {} }) => {
    const code = randomBytes(12).toString('base64url')
    state.codes.set(code, { challenge, nonce, claims })
    return code
  }

  state.handle = async (url, init) => {
    if (url.href === `${ISSUER}/.well-known/jwks.json`) {
      state.jwksFetches += 1
      return Response.json({ keys: state.keys.map(key => key.jwk) })
    }
    const body = new URLSearchParams(String(init?.body ?? ''))
    if (url.href === `${DOMAIN}/oauth2/revoke`) {
      state.revoked.push(body.get('token'))
      return new Response('', { status: 200 })
    }
    if (url.href !== `${DOMAIN}/oauth2/token`) return undefined
    if (body.get('client_id') !== CLIENT_ID) return Response.json({ error: 'invalid_client' }, { status: 400 })
    if (body.get('grant_type') === 'authorization_code') {
      const issued = state.codes.get(body.get('code'))
      state.codes.delete(body.get('code'))
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
      if (!issued || issued.challenge !== challenge || body.get('redirect_uri') !== `${PUBLIC_URL}/auth/callback`) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      const refresh = randomBytes(16).toString('base64url')
      state.refreshTokens.set(refresh, issued.claims)
      return Response.json({ id_token: state.idToken({ nonce: issued.nonce, ...issued.claims }), access_token: 'test-access', refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' })
    }
    if (body.get('grant_type') === 'refresh_token') {
      state.refreshCalls += 1
      const claims = state.refreshTokens.get(body.get('refresh_token'))
      if (claims === undefined) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({ id_token: state.idToken(claims), access_token: 'test-access', expires_in: 3600, token_type: 'Bearer' })
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }
  return state
}

export function createSla() {
  const state = {
    calls: [],
    // Per Cognito subject: an HTTP status, or a body for 200.
    answers: new Map(),
    defaultBody: { staff: { id: 'staff-1', email: 'ana@example.com', displayName: 'Ana Test', role: 'support' }, agents: { 'bot-a': 'owner', 'bot-b': 'reader' } },
    down: false,
  }
  state.handle = async (url, init) => {
    if (url.href !== `${SLA_URL}/api/atenea/me`) return undefined
    if (state.down) throw new TypeError('fetch failed')
    const token = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    state.calls.push(claims.sub)
    const answer = state.answers.get(claims.sub) ?? state.defaultBody
    return typeof answer === 'number' ? new Response('', { status: answer }) : Response.json(answer)
  }
  return state
}

export function fakeFetch(...handlers) {
  return async (input, init) => {
    const url = new URL(input)
    for (const handler of handlers) {
      const response = await handler(url, init)
      if (response !== undefined) return response
    }
    throw new Error(`unexpected fetch to ${url.href}`)
  }
}

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// The dsh web stand-in. It checks what dsh checks: the owner cookie on every request and
// the launch token on GET /. It records every request it sees.
export async function startDsh() {
  const state = {
    token: randomBytes(12).toString('hex'),
    cookie: randomBytes(12).toString('hex'),
    exchanges: 0,
    requests: [],
    upgrades: [],
    sockets: new Set(),
  }
  const owner = headers => String(headers.cookie ?? '').split(';').some(part => part.trim() === `dsh-auth-test=${state.cookie}`)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://dsh.invalid')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== state.token) {
        res.writeHead(401)
        return res.end()
      }
      state.exchanges += 1
      res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-test=${state.cookie}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` })
      return res.end()
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (!owner(req.headers)) {
        res.writeHead(401)
        return res.end()
      }
      if (url.pathname === '/api/bot/feed') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: hello\ndata: {}\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-test=leak; Path=/' })
      res.end(JSON.stringify({ path: url.pathname, method: req.method }))
    })
  })
  server.on('upgrade', (req, socket) => {
    state.upgrades.push({ url: req.url, headers: req.headers })
    if (!owner(req.headers)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: dsh-auth-test=leak\r\n\r\n`)
    state.sockets.add(socket)
    socket.on('close', () => state.sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', data => socket.write(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  state.port = server.address().port
  state.origin = `http://127.0.0.1:${state.port}`
  // What a dsh restart with a fresh owner key looks like to the gateway.
  state.restart = () => {
    state.token = randomBytes(12).toString('hex')
    state.cookie = randomBytes(12).toString('hex')
  }
  state.close = async () => {
    for (const socket of state.sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  return state
}

export async function startEnv({ fileRoots = ['/workspace'] } = {}) {
  const clock = createClock()
  const cognito = createCognito(clock)
  const sla = createSla()
  const dsh = await startDsh()
  const dir = mkdtempSync(join(tmpdir(), 'atenea-gateway-test-'))
  const launchFile = join(dir, 'dsh-launch-url')
  const writeLaunch = () => writeFileSync(launchFile, `dsh web: http://127.0.0.1:3080/?token=${dsh.token}\n`, { mode: 0o600 })
  writeLaunch()
  const logs = []
  const config = {
    host: '127.0.0.1',
    port: 0,
    publicUrl: PUBLIC_URL,
    cognito: { domain: DOMAIN, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: undefined },
    slaUrl: SLA_URL,
    identitySecret: IDENTITY_SECRET,
    dsh: { upstream: dsh.origin, launchUrlFile: launchFile },
    fileRoots,
  }
  const gateway = createGateway(config, { fetch: fakeFetch(cognito.handle, sla.handle), now: clock.now, log: line => logs.push(line) })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const port = gateway.server.address().port
  return {
    clock, cognito, sla, dsh, gateway, config, logs, port, launchFile, writeLaunch,
    request: options => request(port, options),
    async close() {
      await gateway.close()
      await dsh.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: PUBLIC_HOST, ...headers }, agent: false }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

export const cookieOf = (response, name) => [response.headers['set-cookie'] ?? []].flat().find(line => line.startsWith(`${name}=`))
export const cookiePair = line => line.split(';', 1)[0]

// The whole sign-in: /auth/login, the Hosted UI (simulated), /auth/callback. Returns the
// session cookie pair, ready for a Cookie header.
export async function signIn(env, { claims = {}, returnTo } = {}) {
  const login = await env.request({ path: returnTo ? `/auth/login?return_to=${encodeURIComponent(returnTo)}` : '/auth/login' })
  const authorize = new URL(login.headers.location)
  const loginCookie = cookiePair(cookieOf(login, '__Host-atenea_login'))
  const code = env.cognito.issueCode({ challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce'), claims })
  const callback = await env.request({
    path: `/auth/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`,
    headers: { cookie: loginCookie },
  })
  const session = cookieOf(callback, 'atenea_session')
  return { callback, cookie: session ? cookiePair(session) : undefined }
}

// A raw WebSocket handshake through the gateway; resolves with the socket and the response head.
export function openWebSocket(port, { path = '/api/remote.mux', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${PUBLIC_HOST}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ]
    let buffer = Buffer.alloc(0)
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const head = buffer.subarray(0, end).toString()
      const status = Number(head.split(' ')[1])
      resolve({ socket, status, head, key, rest: buffer.subarray(end + 4) })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('close', () => resolve({ socket, status: 0, head: '', key, rest: buffer }))
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  })
}

// ds-bot's live feed through the gateway: resolves with the first event and a promise
// that settles when the stream is cut.
export function openFeed(port, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/bot/feed', headers: { host: PUBLIC_HOST, cookie }, agent: false }, (res) => {
      const closedFeed = new Promise(done => res.socket.once('close', done))
      res.once('data', data => resolve({ status: res.statusCode, first: data.toString(), closed: closedFeed }))
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
}

export const nextData = socket => new Promise((resolve) => {
  socket.once('data', data => resolve(data))
})

export const closed = socket => new Promise((resolve) => {
  if (socket.destroyed) return resolve()
  socket.once('close', () => resolve())
})
