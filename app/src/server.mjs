// Server mode (docs/plans/2026-11-05-desktop-server-client.md): the app opens a team that runs on
// a server instead of booting a DSH Host of its own. The plain rules live here, so that the
// tests run without Electron: where the server address comes from, whether the server answered,
// which pages stay in the window, what the server's page may ask for and which access links the
// window may load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SERVER_ENV = 'ATENEA_SERVER_URL'
export const SERVER_FILE = 'server.json'
export const PROBE_TIMEOUT_MS = 4_000
export const RETRY_MS = 5_000
export const LINK_MAX = 4_096
// The gateway's sign-in on the server's own origin. It runs in the system browser from start to
// end: its state cookie and its callback have to meet in one browser.
export const AUTH_PATH = '/auth'
// Sign-in pages that refuse embedded browsers (Google does) or that the gateway sends to.
export const AUTH_HOSTS = Object.freeze(['accounts.google.com', 'login.microsoftonline.com'])
// Cognito's hosted sign-in: <prefix>.auth.<region>.amazoncognito.com.
export const AUTH_DOMAINS = Object.freeze(['amazoncognito.com'])
// What the server's own page may ask of the window; the rest, and every other origin, is refused.
export const SERVER_PERMISSIONS = Object.freeze(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'notifications'])

// Words that keep the app's own engine, also over a default of the build.
const LOCAL_WORDS = new Set(['', 'local'])

/**
 * A server address: https only, no user name or password, nothing after the host. A path
 * would put the team under a folder of the origin, which the navigation rules do not know.
 * @returns {{ ok: true, origin: string, url: string } | { ok: false, reason: 'malformed' | 'protocol' | 'credentials' | 'path' }}
 */
export function serverAddressOf(text) {
  let url
  try {
    url = new URL(String(text).trim())
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'protocol' }
  if (url.hostname === '') return { ok: false, reason: 'malformed' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return { ok: false, reason: 'path' }
  return { ok: true, origin: url.origin, url: `${url.origin}/` }
}

const UNREADABLE = Symbol('unreadable')

// A JSON file that is not there is no answer; one that cannot be read or parsed is a wrong one.
function readJson(path, read) {
  let text
  try {
    text = read(path)
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? undefined : UNREADABLE
  }
  try {
    return JSON.parse(text)
  } catch {
    return UNREADABLE
  }
}

function choose(value, source) {
  const text = String(value).trim()
  if (LOCAL_WORDS.has(text.toLowerCase())) return { mode: 'local', source }
  const address = serverAddressOf(text)
  return address.ok ? { mode: 'server', source, origin: address.origin, url: address.url } : { mode: 'invalid', source, reason: address.reason }
}

/**
 * Where the team runs. The first of these that is set decides: ATENEA_SERVER_URL, server.json
 * (`{ "url": "https://…" }`) in the app's own data, `atenea.serverUrl` in the app's package.json.
 * An empty value or `local` keeps the app's own engine. An address that is set but cannot be
 * used is not passed over for the next one: the app says so instead of running somewhere the
 * user did not choose.
 * @param {{ env?: Record<string, string | undefined>, userData: string, appPath: string, read?: (path: string) => string }} where
 * @returns {{ mode: 'local', source: string }
 *   | { mode: 'server', source: string, origin: string, url: string }
 *   | { mode: 'invalid', source: string, reason: string }}
 */
export function resolveServer({ env = process.env, userData, appPath, read = path => readFileSync(path, 'utf8') }) {
  if (env[SERVER_ENV] !== undefined) return choose(env[SERVER_ENV], 'env')
  const saved = readJson(join(userData, SERVER_FILE), read)
  if (saved !== undefined) {
    if (saved === UNREADABLE || typeof saved?.url !== 'string') return { mode: 'invalid', source: 'file', reason: 'unreadable' }
    return choose(saved.url, 'file')
  }
  const own = readJson(join(appPath, 'package.json'), read)
  const builtIn = own === UNREADABLE ? undefined : own?.atenea?.serverUrl
  if (typeof builtIn === 'string') return choose(builtIn, 'package')
  return { mode: 'local', source: 'none' }
}

/** Where a server setting came from, for the log. */
export const sourceName = source => ({ env: SERVER_ENV, file: SERVER_FILE, package: 'package.json', none: 'no setting' })[source] ?? String(source)

// How a request that got no HTTP answer failed: Chromium's net::ERR_* names (Electron's
// net.request) and Node's error codes, most specific first.
const NO_ANSWER = [
  ['dns', /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/u],
  ['timeout', /TimeoutError|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/u],
  ['refused', /ERR_CONNECTION_REFUSED|ECONNREFUSED/u],
  ['tls', /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS/u],
  ['network', /ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_ACCESS_DENIED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|EHOSTUNREACH|ENETUNREACH|ECONNRESET/u],
]

/**
 * Whether the server is there. Any HTTP answer says so, 401 and redirects included: the server
 * answered, and the window deals with what it says. No answer at all (no name, no route, no
 * connection, no answer in time, no TLS) says that the VPN is not up.
 * @param {{ status?: number, error?: any }} outcome
 * @returns {{ reachable: true, status: number } | { reachable: false, reason: 'dns' | 'timeout' | 'refused' | 'tls' | 'network' | 'other' }}
 */
export function reachabilityOf(outcome) {
  if (Number.isInteger(outcome?.status) && outcome.status > 0) return { reachable: true, status: outcome.status }
  const error = outcome?.error
  const text = [error?.name, error?.code, error?.message, error?.cause?.code, error?.cause?.message].filter(part => typeof part === 'string').join(' ')
  for (const [reason, pattern] of NO_ANSWER) if (pattern.test(text)) return { reachable: false, reason }
  return { reachable: false, reason: 'other' }
}

/**
 * Asks the server once, through Electron's net.request: Chromium's own network stack, with the
 * same name lookup, proxy and certificates as the window. A redirect is an answer and is not
 * followed; no cookie goes along.
 * @param {string} url
 * @param {{ request: (options: object) => any, timeout?: number }} options `request`: net.request
 */
export function probe(url, { request, timeout = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let asked
    let done = false
    const finish = (outcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { asked?.abort() } catch { /* already over */ }
      resolve(reachabilityOf(outcome))
    }
    const timer = setTimeout(() => { finish({ error: { name: 'TimeoutError' } }) }, timeout)
    try {
      asked = request({ method: 'GET', url, redirect: 'manual', cache: 'no-store', useSessionCookies: false })
      asked.on('redirect', (statusCode) => { finish({ status: statusCode }) })
      asked.on('response', (response) => { finish({ status: response?.statusCode }) })
      asked.on('error', (error) => { finish({ error }) })
      asked.end()
    } catch (error) {
      finish({ error })
    }
  })
}

const authPath = path => path === AUTH_PATH || path.startsWith(`${AUTH_PATH}/`)

/**
 * Where a page goes. The server's own pages stay in the window. Sign-in pages go to the system
 * browser ('auth'): Google refuses embedded browsers, and the gateway's sign-in has to run in
 * one browser from start to end. Every other web page goes to the system browser ('outside'),
 * and anything that is not a web page goes nowhere.
 * @returns {'inside' | 'auth' | 'outside' | 'blocked'}
 */
export function navigationOf(url, origin) {
  let target
  try {
    target = new URL(url)
  } catch {
    return 'blocked'
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'blocked'
  if (target.origin === origin && target.username === '' && target.password === '') return authPath(target.pathname) ? 'auth' : 'inside'
  const host = target.hostname.toLowerCase()
  if (AUTH_HOSTS.includes(host) || AUTH_DOMAINS.some(domain => host.endsWith(`.${domain}`))) return 'auth'
  return 'outside'
}

/**
 * A pasted access link (https://<server>/?token=…): it must be on the server's own origin and
 * carry a token. The window loads it once; the token never goes into the log.
 * @returns {{ ok: true, url: string } | { ok: false, reason: 'empty' | 'long' | 'malformed' | 'origin' | 'token' }}
 */
export function accessLinkOf(text, origin) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return { ok: false, reason: 'empty' }
  if (value.length > LINK_MAX) return { ok: false, reason: 'long' }
  let url
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '' || authPath(url.pathname)) return { ok: false, reason: 'origin' }
  if (!url.searchParams.get('token')) return { ok: false, reason: 'token' }
  url.hash = ''
  return { ok: true, url: url.href }
}

/** A page's address for the log: its origin and path, never its query, which can hold a token. */
export function loggable(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? `${parsed.origin}${parsed.pathname}` : `${parsed.protocol} address`
  } catch {
    return 'an address that does not parse'
  }
}

/** Whether the window grants a permission: only to the server's own origin, only those it needs. */
export function permissionAllowed(permission, from, origin) {
  if (!SERVER_PERMISSIONS.includes(permission)) return false
  try {
    return new URL(from).origin === origin
  } catch {
    return false
  }
}
