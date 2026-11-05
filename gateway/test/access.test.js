import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccessUnavailable, parseAccess } from '../src/access.js'
import { ACCESS_CHECK_MS, ACCESS_GRACE_MS } from '../src/gateway.js'
import { closed, openWebSocket, PUBLIC_URL, signIn, startEnv } from './helpers.js'

const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
const page = { accept: 'text/html' }

test('the SLA answer is read leniently but never widens a role', () => {
  assert.deepEqual(parseAccess({ staff: { id: 's-1', email: 'a@example.com', displayName: 'Ana', role: 'superadmin' }, agents: { b1: 'owner', b2: 'admin', b3: 'reader' } }),
    { id: 's-1', email: 'a@example.com', name: 'Ana', role: 'superadmin', agents: { b1: 'owner', b3: 'reader' } })
  assert.deepEqual(parseAccess({ id: 7, email: 'a@example.com', name: 'Ana', agents: [{ botId: 'b1', role: 'editor' }, { botId: 'b2', role: 'root' }] }),
    { id: '7', email: 'a@example.com', name: 'Ana', role: '', agents: { b1: 'editor' } })
  assert.throws(() => parseAccess({ staff: {} }), AccessUnavailable)
})

for (const status of [401, 403]) {
  test(`SLA answering ${status} at sign-in shows the no-access page and makes no session`, async (t) => {
    const env = await startEnv()
    t.after(() => env.close())
    env.sla.answers.set('cognito-sub-1', status)
    const { callback, cookie } = await signIn(env)
    assert.equal(callback.status, 403)
    assert.equal(cookie, undefined)
    assert.match(callback.body, /Tu cuenta no tiene acceso a Atenea/)
    assert.match(callback.headers['content-type'], /text\/html/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(env.cognito.revoked.length, 1)
  })

  test(`SLA answering ${status} later ends the session and closes its WebSockets`, async (t) => {
    const env = await startEnv()
    t.after(() => env.close())
    const { cookie } = await signIn(env)
    const ws = await openWebSocket(env.port, { headers: { Cookie: cookie, Origin: PUBLIC_URL } })
    assert.equal(ws.status, 101)
    env.sla.answers.set('cognito-sub-1', status)
    env.clock.advance(ACCESS_CHECK_MS - 1)
    assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
    env.clock.advance(1)
    // The periodic check reaches sessions that only hold a stream open.
    await env.gateway.sweep()
    await closed(ws.socket)
    const visit = await env.request({ path: '/', headers: { cookie, ...page } })
    assert.equal(visit.status, 302)
    assert.match(visit.headers.location, /^\/auth\/login/)
  })
}

test('the next request after a suspension gets the no-access answer', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  env.sla.answers.set('cognito-sub-1', 403)
  env.clock.advance(ACCESS_CHECK_MS)
  const visit = await env.request({ path: '/', headers: { cookie, ...page } })
  assert.equal(visit.status, 403)
  assert.match(visit.body, /Tu cuenta no tiene acceso a Atenea/)
  assert.match(visit.headers['set-cookie'][0], /^atenea_session=; .*Max-Age=0/)
  const api = await env.request({ method: 'POST', path: '/api/bot', headers: { cookie, origin: PUBLIC_URL } })
  assert.equal(api.status, 401)
})

test('access is checked again at most once a minute per session', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  assert.equal(env.sla.calls.length, 1)
  for (let i = 0; i < 3; i += 1) await env.request({ path: '/', headers: { cookie } })
  assert.equal(env.sla.calls.length, 1)
  env.sla.defaultBody = { staff: { id: 'staff-1', email: 'ana@example.com', displayName: 'Ana Test', role: 'support' }, agents: { 'bot-c': 'editor' } }
  env.clock.advance(ACCESS_CHECK_MS)
  await env.request({ path: '/', headers: { cookie } })
  assert.equal(env.sla.calls.length, 2)
  const seen = env.dsh.requests[env.dsh.requests.length - 1]
  assert.deepEqual(decode(seen.headers['x-atenea-identity']).agents, { 'bot-c': 'editor' })
})

test('while SLA is down the last answer stands for a while, then requests are refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  env.sla.down = true
  env.clock.advance(ACCESS_CHECK_MS)
  assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
  env.clock.advance(ACCESS_GRACE_MS)
  const refused = await env.request({ path: '/', headers: { cookie, ...page } })
  assert.equal(refused.status, 503)
  env.sla.down = false
  env.clock.advance(60_000)
  assert.equal((await env.request({ path: '/', headers: { cookie } })).status, 200)
})

test('SLA being down at sign-in shows the unavailable page', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  env.sla.down = true
  const { callback, cookie } = await signIn(env)
  assert.equal(callback.status, 503)
  assert.equal(cookie, undefined)
})

test('the ID token is refreshed before it expires and the new one is forwarded', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  await env.request({ path: '/', headers: { cookie } })
  const before = env.dsh.requests[env.dsh.requests.length - 1].headers['x-atenea-sla-token']
  env.clock.advance(56 * 60_000)
  await env.request({ path: '/', headers: { cookie } })
  assert.equal(env.cognito.refreshCalls, 1)
  const after = env.dsh.requests[env.dsh.requests.length - 1].headers['x-atenea-sla-token']
  assert.notEqual(after, before)
  assert.ok(decode(after).exp > decode(before).exp)
})

test('a refresh token Cognito refuses ends the session', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  env.cognito.refreshTokens.clear()
  env.clock.advance(56 * 60_000)
  const visit = await env.request({ path: '/', headers: { cookie, ...page } })
  assert.equal(visit.status, 302)
  assert.match(visit.headers.location, /^\/auth\/login/)
})
