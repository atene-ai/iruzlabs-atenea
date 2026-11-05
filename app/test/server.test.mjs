// Server mode (docs/plans/2026-11-05-desktop-server-client.md): where the server address comes
// from, whether the server answered, where the window's pages go (the team and its sign-in stay,
// Google and Microsoft do not), what the server's page may ask for and which access links the
// window loads.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  accessLinkOf, FEDERATED_HOSTS, federatedName, LINK_MAX, loggable, navigationOf, permissionAllowed, probe, reachabilityOf, resolveServer, SERVER_ENV, SERVER_FILE, serverAddressOf, sourceName,
} from '../src/server.mjs'

const SERVER = 'https://ia.example.test'

// The app's own data and its package, in throwaway folders.
function places({ file, pkg } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atenea-server-'))
  const userData = join(root, 'userData')
  const appPath = join(root, 'app')
  mkdirSync(userData, { recursive: true })
  mkdirSync(appPath, { recursive: true })
  if (file !== undefined) writeFileSync(join(userData, SERVER_FILE), typeof file === 'string' ? file : JSON.stringify(file))
  if (pkg !== undefined) writeFileSync(join(appPath, 'package.json'), JSON.stringify(pkg))
  return { userData, appPath }
}

const PACKAGE = { name: 'atenea', atenea: { serverUrl: 'https://default.example.test' } }

test('the setting comes from ATENEA_SERVER_URL, then server.json, then package.json', () => {
  const all = places({ file: { url: 'https://file.example.test' }, pkg: PACKAGE })
  assert.deepEqual(resolveServer({ env: { [SERVER_ENV]: 'https://env.example.test' }, ...all }),
    { mode: 'server', source: 'env', origin: 'https://env.example.test', url: 'https://env.example.test/' })
  assert.deepEqual(resolveServer({ env: {}, ...all }),
    { mode: 'server', source: 'file', origin: 'https://file.example.test', url: 'https://file.example.test/' })
  assert.deepEqual(resolveServer({ env: {}, ...places({ pkg: PACKAGE }) }),
    { mode: 'server', source: 'package', origin: 'https://default.example.test', url: 'https://default.example.test/' })
  // Without any of them, and in a package without the field, the app runs its own engine.
  assert.deepEqual(resolveServer({ env: {}, ...places() }), { mode: 'local', source: 'none' })
  assert.deepEqual(resolveServer({ env: {}, ...places({ pkg: { name: 'atenea' } }) }), { mode: 'local', source: 'none' })
})

test('an empty value or local keeps the local engine over a default of the build', () => {
  const all = places({ file: { url: 'https://file.example.test' }, pkg: PACKAGE })
  for (const value of ['', 'local', ' LOCAL ', 'Local']) {
    assert.deepEqual(resolveServer({ env: { [SERVER_ENV]: value }, ...all }), { mode: 'local', source: 'env' }, JSON.stringify(value))
  }
  for (const url of ['', 'local']) {
    assert.deepEqual(resolveServer({ env: {}, ...places({ file: { url }, pkg: PACKAGE }) }), { mode: 'local', source: 'file' })
  }
  assert.deepEqual(resolveServer({ env: {}, ...places({ pkg: { atenea: { serverUrl: 'local' } } }) }), { mode: 'local', source: 'package' })
})

test('a setting that cannot be used is refused, not passed over for the next one', () => {
  const all = places({ file: { url: 'https://file.example.test' }, pkg: PACKAGE })
  assert.deepEqual(resolveServer({ env: { [SERVER_ENV]: 'http://ia.example.test' }, ...all }), { mode: 'invalid', source: 'env', reason: 'protocol' })
  assert.deepEqual(resolveServer({ env: { [SERVER_ENV]: 'ia.example.test' }, ...all }), { mode: 'invalid', source: 'env', reason: 'malformed' })
  assert.deepEqual(resolveServer({ env: {}, ...places({ file: { url: 'ftp://ia.example.test' }, pkg: PACKAGE }) }), { mode: 'invalid', source: 'file', reason: 'protocol' })
  // A server.json that does not parse, or has no url, is a wrong setting too.
  for (const file of ['{ not json', '[]', '{}', '{"url": 42}', 'null']) {
    assert.deepEqual(resolveServer({ env: {}, ...places({ file, pkg: PACKAGE }) }), { mode: 'invalid', source: 'file', reason: 'unreadable' }, file)
  }
  assert.deepEqual(resolveServer({ env: {}, ...places({ pkg: { atenea: { serverUrl: 'http://default.example.test' } } }) }), { mode: 'invalid', source: 'package', reason: 'protocol' })
})

test('a server.json that cannot be read is a wrong setting; one that is not there is none', () => {
  const where = { env: {}, userData: '/nowhere/userData', appPath: '/nowhere/app' }
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
  assert.deepEqual(resolveServer({ ...where, read: () => { throw denied } }), { mode: 'invalid', source: 'file', reason: 'unreadable' })
  assert.deepEqual(resolveServer({ ...where, read: () => { throw missing } }), { mode: 'local', source: 'none' })
})

test('only an https address with nothing after the host is a server address', () => {
  assert.deepEqual(serverAddressOf('https://ia.example.test'), { ok: true, origin: SERVER, url: `${SERVER}/` })
  assert.deepEqual(serverAddressOf(' https://IA.Example.test/ '), { ok: true, origin: SERVER, url: `${SERVER}/` })
  assert.deepEqual(serverAddressOf('https://ia.example.test:8443'), { ok: true, origin: 'https://ia.example.test:8443', url: 'https://ia.example.test:8443/' })
  assert.deepEqual(serverAddressOf('https://ia.example.test:443/'), { ok: true, origin: SERVER, url: `${SERVER}/` })
  assert.equal(serverAddressOf('http://ia.example.test').reason, 'protocol')
  assert.equal(serverAddressOf('ws://ia.example.test').reason, 'protocol')
  assert.equal(serverAddressOf('file:///etc/passwd').reason, 'protocol')
  assert.equal(serverAddressOf('javascript:alert(1)').reason, 'protocol')
  assert.equal(serverAddressOf('https://user:pass@ia.example.test').reason, 'credentials')
  assert.equal(serverAddressOf('https://ia.example.test/team').reason, 'path')
  assert.equal(serverAddressOf('https://ia.example.test/?token=x').reason, 'path')
  assert.equal(serverAddressOf('https://ia.example.test/#x').reason, 'path')
  assert.equal(serverAddressOf('not a url').reason, 'malformed')
  assert.equal(serverAddressOf('').reason, 'malformed')
})

test('the log names where the setting came from', () => {
  assert.equal(sourceName('env'), 'ATENEA_SERVER_URL')
  assert.equal(sourceName('file'), 'server.json')
  assert.equal(sourceName('package'), 'package.json')
})

test('any HTTP answer means the server is there, 401 and redirects included', () => {
  for (const status of [200, 204, 301, 302, 401, 403, 404, 500, 502]) assert.deepEqual(reachabilityOf({ status }), { reachable: true, status })
})

test('no answer at all says why: no name, no answer in time, refused, no TLS, no route', () => {
  const chromium = message => ({ error: new Error(message) })
  const node = code => ({ error: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }) })
  const cases = [
    [chromium('net::ERR_NAME_NOT_RESOLVED'), 'dns'],
    [node('ENOTFOUND'), 'dns'],
    [node('EAI_AGAIN'), 'dns'],
    [{ error: { name: 'TimeoutError' } }, 'timeout'],
    [chromium('net::ERR_CONNECTION_TIMED_OUT'), 'timeout'],
    [chromium('net::ERR_TIMED_OUT'), 'timeout'],
    [node('ETIMEDOUT'), 'timeout'],
    [node('UND_ERR_CONNECT_TIMEOUT'), 'timeout'],
    [chromium('net::ERR_CONNECTION_REFUSED'), 'refused'],
    [node('ECONNREFUSED'), 'refused'],
    [chromium('net::ERR_CERT_DATE_INVALID'), 'tls'],
    [chromium('net::ERR_CERT_AUTHORITY_INVALID'), 'tls'],
    [chromium('net::ERR_SSL_PROTOCOL_ERROR'), 'tls'],
    [node('SELF_SIGNED_CERT_IN_CHAIN'), 'tls'],
    [chromium('net::ERR_ADDRESS_UNREACHABLE'), 'network'],
    [chromium('net::ERR_INTERNET_DISCONNECTED'), 'network'],
    [chromium('net::ERR_NETWORK_CHANGED'), 'network'],
    [chromium('net::ERR_CONNECTION_RESET'), 'network'],
    [node('EHOSTUNREACH'), 'network'],
    [node('ENETUNREACH'), 'network'],
    [chromium('something else'), 'other'],
    [{}, 'other'],
    [undefined, 'other'],
    [{ status: 0 }, 'other'],
  ]
  for (const [outcome, reason] of cases) assert.deepEqual(reachabilityOf(outcome), { reachable: false, reason }, JSON.stringify(outcome?.error?.message ?? outcome))
})

// Electron's net.request: an EventEmitter that answers with 'response', 'redirect' or 'error'.
function fakeRequest(answer) {
  const asked = []
  const request = (options) => {
    asked.push(options)
    const emitter = new EventEmitter()
    emitter.end = () => { setImmediate(() => { if (!emitter.aborted) answer(emitter) }) }
    emitter.abort = () => { emitter.aborted = true }
    return emitter
  }
  return { request, asked }
}

test('the probe asks once, without cookies, and does not follow a redirect', async () => {
  const ok = fakeRequest(emitter => emitter.emit('response', { statusCode: 401 }))
  assert.deepEqual(await probe(`${SERVER}/`, { request: ok.request }), { reachable: true, status: 401 })
  assert.deepEqual(ok.asked, [{ method: 'GET', url: `${SERVER}/`, redirect: 'manual', cache: 'no-store', useSessionCookies: false }])
  const moved = fakeRequest(emitter => emitter.emit('redirect', 302, 'GET', `${SERVER}/auth/login`))
  assert.deepEqual(await probe(`${SERVER}/`, { request: moved.request }), { reachable: true, status: 302 })
  const away = fakeRequest(emitter => emitter.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED')))
  assert.deepEqual(await probe(`${SERVER}/`, { request: away.request }), { reachable: false, reason: 'dns' })
  const thrown = await probe(`${SERVER}/`, { request: () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') } })
  assert.deepEqual(thrown, { reachable: false, reason: 'network' })
})

test('a server that does not answer in time is not there, and the request is dropped', async () => {
  let dropped
  const silent = fakeRequest((emitter) => { dropped = emitter })
  assert.deepEqual(await probe(`${SERVER}/`, { request: silent.request, timeout: 50 }), { reachable: false, reason: 'timeout' })
  assert.equal(dropped.aborted, true)
})

// The probe over real sockets, with Node's http standing in for Electron's net.request.
const nodeRequest = (options) => {
  const emitter = new EventEmitter()
  const asked = httpRequest(options.url, { method: options.method }, (response) => {
    response.resume()
    if (response.statusCode >= 300 && response.statusCode < 400) emitter.emit('redirect', response.statusCode)
    else emitter.emit('response', { statusCode: response.statusCode })
  })
  asked.on('error', (error) => { emitter.emit('error', error) })
  emitter.end = () => { asked.end() }
  emitter.abort = () => { asked.destroy() }
  return emitter
}

test('over real sockets: a 401 and a redirect answer, a closed port and a silent server do not', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/silent') return
    if (request.url === '/moved') { response.writeHead(302, { location: 'https://accounts.google.com/' }).end(); return }
    response.writeHead(401).end('unauthorized')
  })
  await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${String(server.address().port)}`
  assert.deepEqual(await probe(`${base}/`, { request: nodeRequest }), { reachable: true, status: 401 })
  assert.deepEqual(await probe(`${base}/moved`, { request: nodeRequest }), { reachable: true, status: 302 })
  assert.deepEqual(await probe(`${base}/silent`, { request: nodeRequest, timeout: 200 }), { reachable: false, reason: 'timeout' })
  const closed = createServer()
  await new Promise((done) => { closed.listen(0, '127.0.0.1', done) })
  const port = closed.address().port
  await new Promise((done) => { closed.close(done) })
  assert.deepEqual(await probe(`http://127.0.0.1:${String(port)}/`, { request: nodeRequest }), { reachable: false, reason: 'refused' })
})

test('the server\'s own pages stay in the window; other sites go to the system browser', () => {
  for (const url of [`${SERVER}/`, `${SERVER}/bot/123?tab=chat#x`, 'https://IA.example.test:443/settings']) assert.equal(navigationOf(url, SERVER), 'inside', url)
  for (const url of ['https://github.com/atene-ai', 'https://example.test/', 'http://ia.example.test/', 'https://ia.example.test:8443/', 'https://other.ia.example.test/', 'https://ia.example.test.evil.test/']) {
    assert.equal(navigationOf(url, SERVER), 'outside', url)
  }
})

test('the sign-in stays in the window: the gateway\'s /auth pages and Cognito\'s hosted pages', () => {
  for (const url of [
    `${SERVER}/auth/login?return_to=%2F`,
    `${SERVER}/auth`,
    `${SERVER}/auth/callback?code=x&state=y`,
    `${SERVER}/auth/logout`,
    'https://iruz-atenea.auth.mx-central-1.amazoncognito.com/oauth2/authorize?client_id=x&state=y',
    'https://iruz-atenea.auth.mx-central-1.amazoncognito.com/login?client_id=x',
    'https://iruz-atenea.auth.mx-central-1.amazoncognito.com/logout?client_id=x&logout_uri=https%3A%2F%2Fia.example.test%2F',
    'https://IRUZ.auth.us-east-1.amazoncognito.com/forgotPassword',
  ]) assert.equal(navigationOf(url, SERVER), 'signin', url)
  // Only the path itself: a page whose name starts with "auth" is a team page.
  assert.equal(navigationOf(`${SERVER}/authors`, SERVER), 'inside')
  // Cognito's own API hosts, plain http, another port, a user name or a look-alike are not its hosted sign-in.
  for (const url of [
    'https://cognito-idp.mx-central-1.amazoncognito.com/',
    'http://iruz.auth.mx-central-1.amazoncognito.com/login',
    'https://iruz.auth.mx-central-1.amazoncognito.com:8443/login',
    'https://someone@iruz.auth.mx-central-1.amazoncognito.com/login',
    'https://iruz.auth.mx-central-1.amazoncognito.com.evil.test/login',
    'https://amazoncognito.com/',
    'https://auth.iruzlabs.com/login',
  ]) assert.equal(navigationOf(url, SERVER), 'outside', url)
})

test('Google and Microsoft are federated: never in the window, and named for the message', () => {
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://ACCOUNTS.google.com/', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize']) {
    assert.equal(navigationOf(url, SERVER), 'federated', url)
  }
  assert.equal(navigationOf('https://accounts.google.com.evil.test/', SERVER), 'outside')
  assert.equal(federatedName('https://accounts.google.com/o/oauth2/v2/auth'), 'Google')
  assert.equal(federatedName('https://login.microsoftonline.com/common'), 'Microsoft')
  assert.equal(federatedName('https://constructor/'), 'constructor')
  assert.equal(FEDERATED_HOSTS['accounts.google.com'], 'Google')
})

test('what is not a web page goes nowhere', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'mailto:a@example.test', 'about:blank', 'chrome://settings', 'not a url', '']) {
    assert.equal(navigationOf(url, SERVER), 'blocked', url)
  }
  // The server's origin with a user name in it is not the server's page.
  assert.equal(navigationOf('https://someone@ia.example.test/', SERVER), 'outside')
})

test('an access link is on the server\'s own origin and carries a token', () => {
  assert.deepEqual(accessLinkOf(`${SERVER}/?token=abc123`, SERVER), { ok: true, url: `${SERVER}/?token=abc123` })
  assert.deepEqual(accessLinkOf(`  ${SERVER}/?token=abc123#ignored\n`, SERVER), { ok: true, url: `${SERVER}/?token=abc123` })
  assert.deepEqual(accessLinkOf(`${SERVER}/team?x=1&token=abc`, SERVER), { ok: true, url: `${SERVER}/team?x=1&token=abc` })
  const refused = [
    ['', 'empty'],
    ['   ', 'empty'],
    [undefined, 'empty'],
    [42, 'empty'],
    ['ia.example.test/?token=abc', 'malformed'],
    ['https://evil.test/?token=abc', 'origin'],
    ['http://ia.example.test/?token=abc', 'origin'],
    ['https://ia.example.test:8443/?token=abc', 'origin'],
    ['https://ia.example.test.evil.test/?token=abc', 'origin'],
    ['https://user:pass@ia.example.test/?token=abc', 'origin'],
    [`${SERVER}/auth/login?token=abc`, 'origin'],
    ['javascript:alert(1)//?token=abc', 'origin'],
    [`${SERVER}/`, 'token'],
    [`${SERVER}/?token=`, 'token'],
    [`${SERVER}/?tok=abc`, 'token'],
    [`${SERVER}/?token=${'a'.repeat(LINK_MAX)}`, 'long'],
  ]
  for (const [text, reason] of refused) assert.deepEqual(accessLinkOf(text, SERVER), { ok: false, reason }, String(text))
})

test('a page\'s address goes into the log without its query', () => {
  assert.equal(loggable(`${SERVER}/?token=secret`), `${SERVER}/`)
  assert.equal(loggable('https://iruz.auth.eu-west-1.amazoncognito.com/oauth2/authorize?state=s&code_challenge=c'), 'https://iruz.auth.eu-west-1.amazoncognito.com/oauth2/authorize')
  assert.equal(loggable('javascript:alert(document.cookie)'), 'javascript: address')
  assert.doesNotMatch(loggable('not a url ?token=secret'), /secret/u)
})

test('the window grants the server\'s page only what it needs, and other origins nothing', () => {
  for (const permission of ['notifications', 'media', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen']) {
    assert.equal(permissionAllowed(permission, `${SERVER}/bot/1`, SERVER), true, permission)
    assert.equal(permissionAllowed(permission, 'https://evil.test/', SERVER), false, permission)
  }
  for (const permission of ['geolocation', 'openExternal', 'midi', 'pointerLock', 'hid', 'serial', 'usb', 'unknown']) assert.equal(permissionAllowed(permission, SERVER, SERVER), false, permission)
  assert.equal(permissionAllowed('notifications', 'file:///start.html', SERVER), false)
  assert.equal(permissionAllowed('notifications', '', SERVER), false)
})
