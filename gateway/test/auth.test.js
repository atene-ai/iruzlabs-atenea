import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { safeReturnTo } from '../src/gateway.js'
import { authorizeUrl, logoutUrl, pkcePair } from '../src/oidc.js'
import { CLIENT_ID, cookieOf, cookiePair, DOMAIN, PUBLIC_URL, signIn, startEnv } from './helpers.js'

test('the PKCE challenge is the S256 hash of a fresh verifier', () => {
  const a = pkcePair()
  const b = pkcePair()
  assert.match(a.verifier, /^[\w-]{43}$/)
  assert.notEqual(a.verifier, b.verifier)
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'))
})

test('the authorize and logout URLs name the Hosted UI, the client and the registered addresses', () => {
  const config = { cognito: { domain: DOMAIN, clientId: CLIENT_ID }, publicUrl: PUBLIC_URL }
  const url = new URL(authorizeUrl(config, { state: 's', challenge: 'c', nonce: 'n' }))
  assert.equal(url.origin + url.pathname, `${DOMAIN}/oauth2/authorize`)
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: CLIENT_ID, response_type: 'code', scope: 'openid email profile', redirect_uri: `${PUBLIC_URL}/auth/callback`,
    state: 's', nonce: 'n', code_challenge: 'c', code_challenge_method: 'S256',
  })
  const logout = new URL(logoutUrl(config))
  assert.equal(logout.searchParams.get('logout_uri'), `${PUBLIC_URL}/`)
})

test('return paths stay on this site and out of /auth', () => {
  assert.equal(safeReturnTo('/chat?bot=a'), '/chat?bot=a')
  for (const value of [null, '', 'https://evil.example', '//evil.example/x', '/\\evil.example', '/auth/logout', 'chat']) {
    assert.equal(safeReturnTo(value), '/', String(value))
  }
})

test('a page visit without a session goes to sign-in and comes back after it', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const visit = await env.request({ path: '/chat?bot=a', headers: { accept: 'text/html' } })
  assert.equal(visit.status, 302)
  assert.equal(visit.headers.location, `/auth/login?return_to=${encodeURIComponent('/chat?bot=a')}`)
  const api = await env.request({ method: 'POST', path: '/api/bot', headers: { origin: PUBLIC_URL } })
  assert.equal(api.status, 401)

  const login = await env.request({ path: '/auth/login?return_to=%2Fchat%3Fbot%3Da' })
  assert.equal(login.status, 302)
  const loginCookie = cookieOf(login, '__Host-atenea_login')
  assert.match(loginCookie, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/)
  const { callback, cookie } = await signIn(env, { returnTo: '/chat?bot=a' })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.location, '/chat?bot=a')
  assert.ok(cookie.startsWith('atenea_session='))
  assert.match(cookieOf(callback, '__Host-atenea_login'), /Max-Age=0/)
  const page = await env.request({ path: '/', headers: { cookie } })
  assert.equal(page.status, 200)
})

test('the callback needs the state this browser started with, once', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const login = await env.request({ path: '/auth/login' })
  const authorize = new URL(login.headers.location)
  const state = authorize.searchParams.get('state')
  const loginCookie = cookiePair(cookieOf(login, '__Host-atenea_login'))
  const code = () => env.cognito.issueCode({ challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce') })

  const noCookie = await env.request({ path: `/auth/callback?code=${code()}&state=${state}` })
  assert.equal(noCookie.status, 400)
  const otherBrowser = await env.request({ path: `/auth/callback?code=${code()}&state=${state}`, headers: { cookie: '__Host-atenea_login=forged' } })
  assert.equal(otherBrowser.status, 400)
  const ok = await env.request({ path: `/auth/callback?code=${code()}&state=${state}`, headers: { cookie: loginCookie } })
  assert.equal(ok.status, 302)
  const replay = await env.request({ path: `/auth/callback?code=${code()}&state=${state}`, headers: { cookie: loginCookie } })
  assert.equal(replay.status, 400)
  assert.match(replay.body, /caducó/)
})

test('a state older than ten minutes is refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const login = await env.request({ path: '/auth/login' })
  const authorize = new URL(login.headers.location)
  env.clock.advance(10 * 60_000)
  const code = env.cognito.issueCode({ challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce') })
  const late = await env.request({ path: `/auth/callback?code=${code}&state=${authorize.searchParams.get('state')}`, headers: { cookie: cookiePair(cookieOf(login, '__Host-atenea_login')) } })
  assert.equal(late.status, 400)
})

test('a code without the matching verifier, an unverified email or a Cognito error signs no one in', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const start = async () => {
    const login = await env.request({ path: '/auth/login' })
    return { authorize: new URL(login.headers.location), cookie: cookiePair(cookieOf(login, '__Host-atenea_login')) }
  }
  let flow = await start()
  const wrongChallenge = env.cognito.issueCode({ challenge: 'not-the-challenge', nonce: flow.authorize.searchParams.get('nonce') })
  let response = await env.request({ path: `/auth/callback?code=${wrongChallenge}&state=${flow.authorize.searchParams.get('state')}`, headers: { cookie: flow.cookie } })
  assert.equal(response.status, 502)
  assert.equal(cookieOf(response, 'atenea_session'), undefined)

  const unverified = await signIn(env, { claims: { email_verified: false } })
  assert.equal(unverified.callback.status, 502)
  assert.equal(unverified.cookie, undefined)

  flow = await start()
  response = await env.request({ path: `/auth/callback?error=access_denied&state=${flow.authorize.searchParams.get('state')}`, headers: { cookie: flow.cookie } })
  assert.equal(response.status, 400)
  assert.equal(env.sla.calls.length, 0)
})

test('sign-out ends the session, revokes the refresh token and leaves through Cognito', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { cookie } = await signIn(env)
  const out = await env.request({ path: '/auth/logout', headers: { cookie } })
  assert.equal(out.status, 302)
  assert.equal(new URL(out.headers.location).pathname, '/logout')
  assert.match(cookieOf(out, 'atenea_session'), /Max-Age=0/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(env.cognito.revoked.length, 1)
  const after = await env.request({ method: 'POST', path: '/api/bot', headers: { cookie, origin: PUBLIC_URL } })
  assert.equal(after.status, 401)
})

test('only the public host name is served, apart from the health check', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const other = await env.request({ path: '/', headers: { host: 'evil.example' } })
  assert.equal(other.status, 421)
  const health = await env.request({ path: '/healthz', headers: { host: '127.0.0.1' } })
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), { ok: true, upstream: true, dshSession: false })
})
