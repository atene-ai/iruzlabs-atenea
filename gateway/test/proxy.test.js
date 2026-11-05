import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { upstreamHeaders } from '../src/proxy.js'
import { closed, IDENTITY_SECRET, nextData, openFeed, openWebSocket, PUBLIC_URL, signIn, startEnv, WS_GUID } from './helpers.js'

const lastRequest = env => env.dsh.requests[env.dsh.requests.length - 1]
const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

test('the browser\'s credentials and identity claims never reach dsh', () => {
  const headers = upstreamHeaders({
    host: 'ia.example.test',
    cookie: 'atenea_session=abc; dsh-auth-x=planted',
    authorization: 'Basic planted',
    origin: 'https://ia.example.test',
    'x-atenea-identity': 'forged',
    'x-atenea-sla-token': 'forged',
    'X-Atenea-Other': 'forged',
    'x-forwarded-for': '10.0.0.1',
    forwarded: 'for=10.0.0.1',
    'sec-fetch-site': 'same-origin',
    connection: 'keep-alive, x-hop',
    'x-hop': 'hop',
    'keep-alive': 'timeout=5',
    'content-type': 'application/json',
    accept: '*/*',
  }, { authority: 'atenea:3080', origin: 'http://atenea:3080', cookie: 'dsh-auth-test=owner', identity: 'signed', slaToken: 'id-token' })
  assert.deepEqual(headers, {
    'content-type': 'application/json',
    accept: '*/*',
    host: 'atenea:3080',
    cookie: 'dsh-auth-test=owner',
    origin: 'http://atenea:3080',
    'x-atenea-identity': 'signed',
    'x-atenea-sla-token': 'id-token',
  })
})

test('a request without Origin gets none upstream', () => {
  const headers = upstreamHeaders({ accept: '*/*' }, { authority: 'a:1', origin: 'http://a:1', cookie: 'c=1', identity: 'i', slaToken: 's' })
  assert.equal(headers.origin, undefined)
})

test('a forwarded request carries the gateway\'s dsh session and a signed identity', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const response = await env.request({
    method: 'POST',
    path: '/api/bot?token=planted&x=1',
    headers: {
      cookie: `${cookie}; dsh-auth-test=planted`,
      origin: PUBLIC_URL,
      'content-type': 'application/json',
      'x-atenea-identity': 'forged',
      'x-atenea-sla-token': 'forged',
      authorization: 'Bearer planted',
    },
    body: JSON.stringify({ endpoint: 'state' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['set-cookie'], undefined, 'dsh cookies stay behind the gateway')
  const seen = lastRequest(env)
  assert.equal(seen.url, '/api/bot?x=1')
  assert.equal(seen.body, JSON.stringify({ endpoint: 'state' }))
  assert.equal(seen.headers.host, `127.0.0.1:${env.dsh.port}`)
  assert.equal(seen.headers.origin, env.dsh.origin)
  assert.equal(seen.headers.cookie, `dsh-auth-test=${env.dsh.cookie}`)
  assert.equal(seen.headers.authorization, undefined)
  assert.doesNotMatch(JSON.stringify(seen.headers), /atenea_session|planted|forged/)

  const [header, payload, signature] = seen.headers['x-atenea-identity'].split('.')
  assert.equal(signature, createHmac('sha256', IDENTITY_SECRET).update(`${header}.${payload}`).digest('base64url'))
  const identity = decode(seen.headers['x-atenea-identity'])
  assert.deepEqual(identity, {
    iss: 'atenea-gateway', aud: 'ds-bot', sub: 'staff-1', email: 'ana@example.com', name: 'Ana Test', role: 'support',
    agents: { 'bot-a': 'owner', 'bot-b': 'reader' }, iat: identity.iat, exp: identity.iat + 120,
  })
  assert.equal(decode(seen.headers['x-atenea-sla-token']).sub, 'cognito-sub-1')
  assert.equal(env.dsh.exchanges, 1)
})

test('a state change from another origin is refused before dsh', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  for (const origin of ['https://zuri.example.test', undefined]) {
    const response = await env.request({ method: 'POST', path: '/api/bot', headers: { cookie, ...(origin ? { origin } : {}) }, body: '{}' })
    assert.equal(response.status, 403)
  }
  assert.equal(env.dsh.requests.length, 0)
})

test('blocked routes never reach dsh', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const headers = { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' }
  assert.equal((await env.request({ method: 'POST', path: '/api/terminal/create', headers, body: '{}' })).status, 403)
  assert.equal((await env.request({ method: 'POST', path: '/api/settings/update', headers, body: '{}' })).status, 403)
  assert.equal((await env.request({ path: '/api/file?path=/data/.credentials.yaml', headers })).status, 403)
  assert.equal((await env.request({ path: '/connect?token=x', headers })).status, 404)
  assert.equal(env.dsh.requests.length, 0)
  assert.equal((await env.request({ method: 'POST', path: '/api/session/list', headers, body: '{}' })).status, 200)
})

test('dsh refusing the gateway\'s cookie makes it trade the new launch token and retry', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const send = () => env.request({ method: 'POST', path: '/api/bot', headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' }, body: '{"endpoint":"state"}' })
  assert.equal((await send()).status, 200)
  env.dsh.restart()
  env.writeLaunch()
  const response = await send()
  assert.equal(response.status, 200)
  assert.equal(env.dsh.exchanges, 2)
  const [refused, retried] = env.dsh.requests.slice(-2)
  assert.notEqual(refused.headers.cookie, retried.headers.cookie)
  assert.equal(retried.body, '{"endpoint":"state"}')
  assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
  assert.equal(env.dsh.exchanges, 2)
})

test('while dsh has not written its launch URL, requests get 503', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  env.dsh.restart()
  const response = await env.request({ path: '/', headers: { cookie } })
  assert.equal(response.status, 503)
  env.writeLaunch()
  assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
})

test('the Remote WebSocket is proxied as the gateway\'s session', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const ws = await openWebSocket(env.port, { headers: { Cookie: `${cookie}; dsh-auth-test=planted`, Origin: PUBLIC_URL, 'X-Atenea-Identity': 'forged' } })
  t.after(() => ws.socket.destroy())
  assert.equal(ws.status, 101)
  const accept = createHash('sha1').update(`${ws.key}${WS_GUID}`).digest('base64')
  assert.match(ws.head, new RegExp(`Sec-WebSocket-Accept: ${accept.replace(/[+/]/g, '\\$&')}`))
  assert.doesNotMatch(ws.head, /Set-Cookie/i)
  const seen = env.dsh.upgrades[0]
  assert.equal(seen.url, '/api/remote.mux')
  assert.equal(seen.headers.host, `127.0.0.1:${env.dsh.port}`)
  assert.equal(seen.headers.origin, env.dsh.origin)
  assert.equal(seen.headers.cookie, `dsh-auth-test=${env.dsh.cookie}`)
  assert.equal(decode(seen.headers['x-atenea-identity']).sub, 'staff-1')
  ws.socket.write('frame-bytes')
  assert.equal((await nextData(ws.socket)).toString(), 'frame-bytes')
})

test('a WebSocket without a session, from another origin or to another path is refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  assert.equal((await openWebSocket(env.port, { headers: { Origin: PUBLIC_URL } })).status, 401)
  assert.equal((await openWebSocket(env.port, { headers: { Cookie: cookie, Origin: 'https://zuri.example.test' } })).status, 403)
  assert.equal((await openWebSocket(env.port, { path: '/api/bot', headers: { Cookie: cookie, Origin: PUBLIC_URL } })).status, 404)
  assert.equal(env.dsh.upgrades.length, 0)
})

test('a WebSocket refused for a stale dsh cookie is retried with a new one', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
  env.dsh.restart()
  env.writeLaunch()
  const ws = await openWebSocket(env.port, { headers: { Cookie: cookie, Origin: PUBLIC_URL } })
  t.after(() => ws.socket.destroy())
  assert.equal(ws.status, 101)
  assert.equal(env.dsh.upgrades.length, 2)
  assert.equal(env.dsh.exchanges, 2)
})

test('signing out closes the session\'s WebSockets and live feeds', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const ws = await openWebSocket(env.port, { headers: { Cookie: cookie, Origin: PUBLIC_URL } })
  assert.equal(ws.status, 101)
  const feed = await openFeed(env.port, cookie)
  assert.match(feed.first, /event: hello/)
  await env.request({ path: '/auth/logout', headers: { cookie } })
  await closed(ws.socket)
  await feed.closed
})
