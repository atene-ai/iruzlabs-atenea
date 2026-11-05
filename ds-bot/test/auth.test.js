import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { PROVIDERS, authSettings, deniedPage, idTokenClaims, install, isAllowedDomain } from '../src/host/auth.js'
import { fakeContext } from './fake-ctx.js'

const GOOGLE_ID = 'google-client.apps.googleusercontent.com'
const MS_ID = '00000000-0000-0000-0000-00000000a11e'
const TENANT = '11111111-2222-3333-4444-555555555555'

const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600
const json = body => ({ ok: true, status: 200, json: async () => body })
const googleClaims = extra => ({ iss: 'https://accounts.google.com', aud: GOOGLE_ID, exp: inAnHour(), email: 'luis@iruzlabs.com', email_verified: true, hd: 'iruzlabs.com', name: 'Luis', ...extra })
const msClaims = extra => ({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_ID, exp: inAnHour(), tid: TENANT, ...extra })

const settingsWith = (config = {}) => authSettings({ googleClientId: GOOGLE_ID, microsoftClientId: MS_ID, ...config }, {})

function runtime(config = {}, authFetch) {
  const state = {}
  const rt = { state, config, save: async () => {}, warn: () => {}, ...(authFetch ? { authFetch } : {}) }
  install(rt)
  return rt
}

test('isAllowedDomain accepts only the corporate domains and their subdomains', () => {
  assert.equal(isAllowedDomain('luis@iruzlabs.com'), true)
  assert.equal(isAllowedDomain('admin@azurylabs.online'), true)
  assert.equal(isAllowedDomain('engineer@sub.iruzlabs.com'), true)
  assert.equal(isAllowedDomain('LUIS@IRUZLABS.COM'), true)

  assert.equal(isAllowedDomain('user@gmail.com'), false)
  assert.equal(isAllowedDomain('user@eviliruzlabs.com'), false)
  assert.equal(isAllowedDomain('user@iruzlabs.com.evil.test'), false)
  assert.equal(isAllowedDomain('@iruzlabs.com'), false)
  assert.equal(isAllowedDomain('a@b@iruzlabs.com'), false)
  assert.equal(isAllowedDomain('invalid-email'), false)
  assert.equal(isAllowedDomain(''), false)
  assert.equal(isAllowedDomain(null), false)
})

test('authSettings reads the plugin config first, then the environment', () => {
  const env = { ATENEA_AUTH_DOMAINS: ' Example.com , ,other.test ', ATENEA_AUTH_SESSION_HOURS: '2', ATENEA_MICROSOFT_TENANT_ID: TENANT.toUpperCase() }
  const fromEnv = authSettings({}, env)
  assert.deepEqual(fromEnv.domains, ['example.com', 'other.test'])
  assert.equal(fromEnv.sessionMs, 2 * 3_600_000)
  assert.equal(fromEnv.required, true)
  assert.equal(fromEnv.devLogin, false)
  assert.deepEqual(fromEnv.microsoft.tenants, [TENANT])

  const fromConfig = authSettings({ authDomains: ['iruzlabs.com'], authRequired: false }, env)
  assert.deepEqual(fromConfig.domains, ['iruzlabs.com'])
  assert.equal(fromConfig.required, false)
  assert.equal(authSettings({}, { ATENEA_AUTH_REQUIRED: '0' }).required, false)
  assert.equal(authSettings({}, { ATENEA_AUTH_SESSION_HOURS: 'soon' }).sessionMs, 24 * 7 * 3_600_000)
})

test('direct sign-in is off unless turned on, and its sessions end when it is turned off', async () => {
  const off = runtime({ authRequired: true })
  await assert.rejects(off.authEndpoint('auth-dev-login', { email: 'luis@iruzlabs.com' }), /Direct sign-in is turned off/)
  assert.equal(off.authLocked(), true)
  assert.equal(off.authView().devLogin, false)

  const on = runtime({ authRequired: true, authDevLogin: true })
  await assert.rejects(on.authEndpoint('auth-dev-login', { email: 'hacker@gmail.com' }), /Only accounts from @iruzlabs\.com, @azurylabs\.online can sign in/)
  const view = await on.authEndpoint('auth-dev-login', { email: 'Luis@IruzLabs.com', name: 'Luis Ramírez', provider: 'microsoft' })
  assert.equal(view.user.email, 'luis@iruzlabs.com')
  assert.equal(view.user.provider, 'microsoft')
  assert.equal(view.user.dev, true)
  assert.equal(on.authLocked(), false)

  // The same saved session, read by a host where direct sign-in is off.
  const later = { state: on.state, config: { authRequired: true }, save: async () => {} }
  install(later)
  assert.equal(later.authView().user, null)
  assert.equal(later.authLocked(), true)

  const signedOut = await on.authEndpoint('auth-sign-out')
  assert.equal(signedOut.user, null)
  assert.equal(on.state.user, null)
})

test('a session ends after its lifetime or when its domain is no longer allowed', () => {
  const rt = runtime({ authRequired: true, authSessionHours: 1 })
  rt.state.user = { email: 'luis@iruzlabs.com', provider: 'google', loggedInAt: Date.now() - 30 * 60_000 }
  assert.equal(rt.authView().user.email, 'luis@iruzlabs.com')
  rt.state.user.loggedInAt = Date.now() - 2 * 3_600_000
  assert.equal(rt.authView().user, null)
  assert.equal(rt.authLocked(), true)

  const narrowed = runtime({ authRequired: true, authDomains: ['azurylabs.online'] })
  narrowed.state.user = { email: 'luis@iruzlabs.com', provider: 'google', loggedInAt: Date.now() }
  assert.equal(narrowed.authLocked(), true)

  const optional = runtime({ authRequired: false })
  assert.equal(optional.authLocked(), false)
})

test('Google sign-in trusts only verified Workspace accounts on an allowed domain, issued for this app', async () => {
  const settings = settingsWith()
  const profile = claims => PROVIDERS.google.profile({ id_token: jwt(claims), access_token: 'at' }, settings)
  assert.deepEqual(await profile(googleClaims()), { name: 'Luis', email: 'luis@iruzlabs.com', avatar: null })
  // A consumer Google account opened with a corporate address carries no `hd`.
  await assert.rejects(profile(googleClaims({ hd: undefined })), /Account not allowed/)
  await assert.rejects(profile(googleClaims({ email_verified: false })), /Account not allowed/)
  await assert.rejects(profile(googleClaims({ email: 'luis@gmail.com', hd: 'gmail.com' })), /Account not allowed/)
  await assert.rejects(profile(googleClaims({ aud: 'someone-else' })), /another app/)
  await assert.rejects(profile(googleClaims({ exp: 1 })), /expired/)
  await assert.rejects(profile(googleClaims({ iss: 'https://evil.test' })), /unexpected issuer/)
  assert.throws(() => idTokenClaims(''), /no ID token/)
  assert.throws(() => idTokenClaims('a.!!!.c'), /unreadable/)
})

test('Microsoft sign-in checks the UPN, not the free-text mail, and the tenant when one is set', async () => {
  const graph = me => async (url, init) => {
    assert.equal(url, 'https://graph.microsoft.com/v1.0/me')
    assert.equal(init.headers.Authorization, 'Bearer at')
    return json(me)
  }
  const tokens = claims => ({ id_token: jwt(claims), access_token: 'at' })
  const settings = settingsWith()
  assert.deepEqual(
    await PROVIDERS.microsoft.profile(tokens(msClaims()), settings, graph({ displayName: 'Ana', userPrincipalName: 'ana@azurylabs.online', mail: 'ana@azurylabs.online' })),
    { name: 'Ana', email: 'ana@azurylabs.online', avatar: null },
  )
  // Another tenant's admin can set any `mail`; the UPN suffix must be a verified domain.
  await assert.rejects(
    PROVIDERS.microsoft.profile(tokens(msClaims()), settings, graph({ userPrincipalName: 'eve@evil.onmicrosoft.com', mail: 'ceo@iruzlabs.com' })),
    /Account not allowed/,
  )
  const pinned = settingsWith({ microsoftTenants: [TENANT] })
  await assert.rejects(PROVIDERS.microsoft.profile(tokens(msClaims({ tid: 'other', iss: 'https://login.microsoftonline.com/other/v2.0' })), pinned, graph({})), /Account not allowed/)
  await assert.rejects(PROVIDERS.microsoft.profile(tokens(msClaims({ iss: 'https://login.microsoftonline.com/other/v2.0' })), settings, graph({})), /unexpected issuer/)
})

test('the authorize URLs use PKCE, keep every allowed Workspace domain and keep personal Microsoft accounts out', () => {
  const settings = settingsWith()
  const args = { redirectUri: 'http://127.0.0.1:1/auth/callback', state: 's', challenge: 'c' }
  const google = new URL(PROVIDERS.google.authorizeUrl(settings, args))
  assert.equal(google.searchParams.get('hd'), '*')
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(new URL(PROVIDERS.google.authorizeUrl(settingsWith({ authDomains: ['iruzlabs.com'] }), args)).searchParams.get('hd'), 'iruzlabs.com')

  assert.match(PROVIDERS.microsoft.authorizeUrl(settings, args), /^https:\/\/login\.microsoftonline\.com\/organizations\/oauth2\/v2\.0\/authorize\?/)
  assert.match(PROVIDERS.microsoft.authorizeUrl(settingsWith({ microsoftTenants: [TENANT] }), args), new RegExp(`/${TENANT}/oauth2/`))
  assert.equal(PROVIDERS.microsoft.tokenUrl(settings), 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token')
})

test('the callback pages escape what the provider sent', () => {
  const html = deniedPage('<img src=x onerror=alert(1)>@evil.test', ['iruzlabs.com'])
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&#60;img'))
})

test('the loopback flow ignores stray requests, signs in once, then stops listening', async (t) => {
  const seen = []
  const authFetch = async (url, init) => {
    seen.push({ url, body: Object.fromEntries(init.body ?? []) })
    return json({ access_token: 'at', id_token: jwt(googleClaims()) })
  }
  const rt = runtime({ authRequired: true, googleClientId: GOOGLE_ID, googleClientSecret: 'desktop-secret' }, authFetch)
  t.after(() => rt.authEndpoint('auth-cancel'))

  assert.deepEqual(await rt.authEndpoint('auth-start', { provider: 'microsoft' }), { configured: false, provider: 'microsoft' })
  const started = await rt.authEndpoint('auth-start', { provider: 'google' })
  assert.equal(started.configured, true)
  const authorize = new URL(started.authUrl)
  const redirect = authorize.searchParams.get('redirect_uri')
  const stateToken = authorize.searchParams.get('state')
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)

  // Any local page could send this; it must not end the flow.
  const stray = await fetch(`${redirect}?state=guess&code=x`)
  assert.equal(stray.status, 400)
  assert.equal(stray.headers.get('referrer-policy'), 'no-referrer')
  await stray.text()
  assert.equal(rt.authLocked(), true)

  const done = await fetch(`${redirect}?state=${stateToken}&code=the-code`)
  assert.equal(done.status, 200)
  assert.match(await done.text(), /luis@iruzlabs\.com/)
  assert.equal(rt.authLocked(), false)
  assert.equal(rt.state.user.email, 'luis@iruzlabs.com')
  assert.equal(rt.state.user.provider, 'google')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].body.code, 'the-code')
  assert.equal(seen[0].body.client_secret, 'desktop-secret')
  assert.equal(seen[0].body.redirect_uri, redirect)
  assert.ok(seen[0].body.code_verifier.length >= 43)

  await assert.rejects(fetch(`${redirect}?state=${stateToken}&code=again`))
})

test('a signed-out client may read and sign in, but not act', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-auth-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], revision: 1, bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: '', instructions: '', createdAt: 1 } }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home, authRequired: true, authDevLogin: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()

  const view = await call('state', {})
  assert.equal(view.ok, true)
  assert.equal(view.value.auth.required, true)
  assert.equal(view.value.auth.user, null)

  const refused = await call('create-bot', { name: 'Writer' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/auth-required')
  assert.equal((await call('approval-answer', {})).error.code, 'bot/auth-required')

  const signedIn = await call('auth-dev-login', { email: 'luis@iruzlabs.com' })
  assert.equal(signedIn.ok, true, JSON.stringify(signedIn))
  const allowed = await call('set-prefs', { enterToSend: false })
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
})
