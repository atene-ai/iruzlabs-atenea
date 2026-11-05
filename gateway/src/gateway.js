// The gateway: staff sign in with Cognito, SLA says whether they may use Atenea, and the
// allowed requests go on to dsh web under the gateway's own owner session, with the staff
// member's identity attached for ds-bot.
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { AccessDenied, AccessUnavailable, fetchAccess } from './access.js'
import { clearCookie, parseCookies, serializeCookie } from './cookies.js'
import { createDshLink, DshUnavailable } from './dsh.js'
import { createJwks, signHs256, TokenError, verifyIdToken } from './jwt.js'
import { authorizeUrl, exchangeCode, logoutUrl, OidcError, pkcePair, randomToken, refreshTokens, revokeToken } from './oidc.js'
import { errorPage, noAccessPage, sendJson, sendPage, unavailablePage } from './pages.js'
import { decide } from './policy.js'
import { forwardHttp, forwardUpgrade, refuse, upstreamHeaders } from './proxy.js'
import { createSessionAccess } from './session-access.js'
import { createSessionGuard } from './session-guard.js'
import { createSessionStore, SESSION_COOKIE } from './sessions.js'

// __Host- keeps a sibling subdomain from planting a login state of its own.
export const LOGIN_COOKIE = '__Host-atenea_login'
const LOGIN_TTL_MS = 10 * 60_000
const MAX_PENDING_LOGINS = 5_000
export const ACCESS_CHECK_MS = 60_000
// While SLA cannot be reached, the last answer stands this long, then requests are refused.
export const ACCESS_GRACE_MS = 5 * 60_000
const ACCESS_RETRY_MS = 15_000
export const REFRESH_MARGIN_MS = 5 * 60_000
export const IDENTITY_TTL_S = 120
const SWEEP_MS = 30_000
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

class SessionExpired extends Error {}

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

// Only a path on this site; anything else signs in to the start page.
export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  try {
    const url = new URL(value, 'http://gateway.invalid')
    if (url.origin !== 'http://gateway.invalid' || url.pathname.startsWith('/auth/')) return '/'
    return `${url.pathname}${url.search}`
  } catch {
    return '/'
  }
}

// dsh trades `token` for an owner cookie; a browser never gets to send one.
function upstreamPath(url) {
  if (!url.searchParams.has('token')) return `${url.pathname}${url.search}`
  const params = new URLSearchParams(url.search)
  params.delete('token')
  const search = params.toString()
  return search ? `${url.pathname}?${search}` : url.pathname
}

const wantsPage = req => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')

export function createGateway(config, { fetch = globalThis.fetch, now = Date.now, log = console.log } = {}) {
  const jwks = createJwks(`${config.cognito.issuer}/.well-known/jwks.json`, { fetch, now })
  const sessions = createSessionStore({ now })
  const link = createDshLink(config.dsh, { now, log })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 })
  const pendingLogins = new Map()
  const publicHost = new URL(config.publicUrl).host.toLowerCase()
  const verifyOptions = { jwks, issuer: config.cognito.issuer, clientId: config.cognito.clientId, now }

  // Tokens and permissions.

  async function refresh(session) {
    if (!session.refreshToken) throw new SessionExpired()
    let tokens
    try {
      tokens = await refreshTokens(config, session.refreshToken, fetch)
    } catch (error) {
      // Cognito refused the refresh token: revoked, expired or the user was disabled.
      if (error instanceof OidcError && error.code !== undefined) throw new SessionExpired()
      if (session.idClaims.exp * 1000 > now()) return
      throw new AccessUnavailable('Cognito is unreachable')
    }
    let claims
    try {
      claims = await verifyIdToken(tokens.id_token, verifyOptions)
    } catch (error) {
      if (error instanceof TokenError) throw new SessionExpired()
      throw error
    }
    if (claims.sub !== session.idClaims.sub) throw new SessionExpired()
    session.idToken = tokens.id_token
    session.idClaims = claims
    if (typeof tokens.refresh_token === 'string') session.refreshToken = tokens.refresh_token
  }

  async function checkAccess(session) {
    try {
      session.access = await fetchAccess(config.slaUrl, session.idToken, fetch)
      session.checkedAt = now()
    } catch (error) {
      if (!(error instanceof AccessUnavailable)) throw error
      session.retryAt = now() + ACCESS_RETRY_MS
      log(`gateway: access check failed for staff ${session.access.id}: ${error.message}`)
    }
  }

  const needsRefresh = session => session.idClaims.exp * 1000 - now() < REFRESH_MARGIN_MS
  const needsCheck = session => now() - session.checkedAt >= ACCESS_CHECK_MS && now() >= session.retryAt

  async function freshen(session) {
    if (needsRefresh(session) || needsCheck(session)) {
      session.freshening ??= (async () => {
        if (needsRefresh(session)) await refresh(session)
        if (needsCheck(session)) await checkAccess(session)
      })().finally(() => { session.freshening = null })
      await session.freshening
    }
    if (now() - session.checkedAt >= ACCESS_GRACE_MS) throw new AccessUnavailable('access could not be checked')
  }

  function endSession(session, reason) {
    if (reason === 'denied') log(`gateway: staff ${session.access.id} lost access; session ended`)
    sessions.end(session, reason)
    if (session.refreshToken && reason !== 'expired') revokeToken(config, session.refreshToken, fetch).catch(() => {})
  }

  // The session a request carries, made fresh: { session, cookie? } or { failure }.
  async function authenticate(req) {
    const value = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const session = value === undefined ? null : sessions.find(value)
    if (session === null) return { failure: 'anonymous', stale: value !== undefined }
    const rotated = sessions.touch(session)
    try {
      await freshen(session)
    } catch (error) {
      if (error instanceof AccessDenied) {
        endSession(session, 'denied')
        return { failure: 'denied' }
      }
      if (error instanceof SessionExpired) {
        endSession(session, 'expired')
        return { failure: 'anonymous', stale: true }
      }
      if (error instanceof AccessUnavailable) return { failure: 'unavailable' }
      throw error
    }
    if (session.ended) return { failure: 'anonymous', stale: true }
    const current = rotated || !value.startsWith(`${session.sid}.`)
    return { session, cookie: current ? sessions.cookie(session) : undefined }
  }

  function identityToken(session) {
    const iat = Math.floor(now() / 1000)
    const { access } = session
    return signHs256({
      iss: 'atenea-gateway',
      aud: 'ds-bot',
      sub: access.id,
      email: access.email || session.idClaims.email || '',
      name: access.name,
      role: access.role,
      agents: access.agents,
      iat,
      exp: iat + IDENTITY_TTL_S,
    }, config.identitySecret)
  }

  const headersFor = (req, session) => cookie => upstreamHeaders(req.headers, {
    authority: link.authority,
    origin: link.origin,
    cookie,
    identity: identityToken(session),
    slaToken: session.idToken,
  })

  // ds-bot answers which DSH Sessions each person may read or write; the guard holds
  // dsh's own Session calls and streams to that.
  const sessionAccess = createSessionAccess({ link, now, headersFor: (session, cookie) => headersFor({ headers: {} }, session)(cookie) })
  const guard = createSessionGuard({ access: sessionAccess, log })

  // Long-lived responses and WebSockets of a session close with it.
  function hold(session, connection, done) {
    session.live.add(connection)
    connection.once(done, () => session.live.delete(connection))
  }

  // Sign-in routes.

  function prunePendingLogins() {
    const at = now()
    for (const [state, login] of pendingLogins) if (login.expiresAt <= at) pendingLogins.delete(state)
    while (pendingLogins.size > MAX_PENDING_LOGINS) pendingLogins.delete(pendingLogins.keys().next().value)
  }

  function login(req, res, url) {
    const state = randomToken(24)
    const nonce = randomToken(16)
    const { verifier, challenge } = pkcePair()
    pendingLogins.set(state, { verifier, nonce, returnTo: safeReturnTo(url.searchParams.get('return_to')), expiresAt: now() + LOGIN_TTL_MS })
    prunePendingLogins()
    res.writeHead(302, {
      location: authorizeUrl(config, { state, challenge, nonce }),
      'set-cookie': serializeCookie(LOGIN_COOKIE, state, { maxAge: LOGIN_TTL_MS / 1000 }),
      'cache-control': 'no-store',
    })
    res.end()
  }

  async function callback(req, res, url) {
    const failed = (status, html) => sendPage(res, status, html, { 'set-cookie': clearCookie(LOGIN_COOKIE) })
    const state = url.searchParams.get('state')
    const browserState = parseCookies(req.headers.cookie).get(LOGIN_COOKIE)
    const pending = state === null ? undefined : pendingLogins.get(state)
    if (pending === undefined || browserState === undefined || !safeEqual(state, browserState) || pending.expiresAt <= now()) {
      return failed(400, errorPage('El inicio de sesión caducó o empezó en otra ventana.'))
    }
    pendingLogins.delete(state)
    const code = url.searchParams.get('code')
    if (url.searchParams.has('error') || !code) return failed(400, errorPage('Cognito no completó el inicio de sesión.'))
    let tokens
    let claims
    try {
      tokens = await exchangeCode(config, { code, verifier: pending.verifier }, fetch)
      claims = await verifyIdToken(tokens.id_token, { ...verifyOptions, nonce: pending.nonce })
    } catch (error) {
      if (!(error instanceof OidcError || error instanceof TokenError)) throw error
      log(`gateway: sign-in failed: ${error.message}`)
      return failed(502, errorPage('No pudimos validar tu sesión con Cognito.'))
    }
    let access
    try {
      access = await fetchAccess(config.slaUrl, tokens.id_token, fetch)
    } catch (error) {
      if (error instanceof AccessDenied) {
        log(`gateway: sign-in refused by SLA for subject ${claims.sub}`)
        if (tokens.refresh_token) revokeToken(config, tokens.refresh_token, fetch).catch(() => {})
        return failed(403, noAccessPage())
      }
      if (error instanceof AccessUnavailable) {
        log(`gateway: sign-in could not check access: ${error.message}`)
        return failed(503, unavailablePage())
      }
      throw error
    }
    const previous = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const replaced = previous === undefined ? null : sessions.find(previous)
    if (replaced !== null) sessions.end(replaced, 'replaced')
    const session = sessions.create({
      idToken: tokens.id_token,
      idClaims: claims,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
      access,
      checkedAt: now(),
      retryAt: 0,
      freshening: null,
    })
    log(`gateway: staff ${access.id} signed in`)
    res.writeHead(302, {
      location: pending.returnTo,
      'set-cookie': [sessions.cookie(session), clearCookie(LOGIN_COOKIE)],
      'cache-control': 'no-store',
    })
    res.end()
  }

  function logout(req, res) {
    const value = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const session = value === undefined ? null : sessions.find(value)
    if (session !== null) endSession(session, 'signed out')
    res.writeHead(302, { location: logoutUrl(config), 'set-cookie': sessions.clearCookie(), 'cache-control': 'no-store' })
    res.end()
  }

  async function health(res) {
    const upstream = await link.reachable()
    sendJson(res, upstream ? 200 : 503, { ok: upstream, upstream, dshSession: link.ready })
  }

  // Requests.

  function unauthenticated(req, res, url, auth) {
    const cookieHeaders = auth.stale ? { 'set-cookie': sessions.clearCookie() } : {}
    if (auth.failure === 'denied') {
      if (wantsPage(req)) return sendPage(res, 403, noAccessPage(), { 'set-cookie': sessions.clearCookie() })
      return sendJson(res, 403, { error: 'atenea/no-access' }, { 'set-cookie': sessions.clearCookie() })
    }
    if (auth.failure === 'unavailable') {
      if (wantsPage(req)) return sendPage(res, 503, unavailablePage())
      return sendJson(res, 503, { error: 'atenea/unavailable' })
    }
    if (wantsPage(req)) {
      const target = `/auth/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`
      res.writeHead(302, { location: target, 'cache-control': 'no-store', ...cookieHeaders })
      return res.end()
    }
    return sendJson(res, 401, { error: 'atenea/sign-in' }, cookieHeaders)
  }

  function parse(req) {
    if (!String(req.url ?? '').startsWith('/')) return null
    try {
      return new URL(req.url, config.publicUrl)
    } catch {
      return null
    }
  }

  const ownHost = req => String(req.headers.host ?? '').toLowerCase() === publicHost
  // A sibling site under the same registrable domain still sends the Lax cookie, so a
  // state change must come from this origin.
  const sameOrigin = req => req.headers.origin === config.publicUrl

  async function route(req, res) {
    const url = parse(req)
    if (url === null) return sendJson(res, 400, { error: 'bad request target' })
    if (url.pathname === '/healthz') return health(res)
    if (!ownHost(req)) return sendJson(res, 421, { error: 'unknown host' })
    if (url.pathname === '/auth/login') return login(req, res, url)
    if (url.pathname === '/auth/callback') return callback(req, res, url)
    if (url.pathname === '/auth/logout') return logout(req, res)
    const auth = await authenticate(req)
    if (auth.failure !== undefined) return unauthenticated(req, res, url, auth)
    if (!SAFE_METHODS.has(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: 'atenea/cross-origin' })
    const decision = decide({ method: req.method, pathname: url.pathname, searchParams: url.searchParams }, config)
    if (!decision.allow) return sendJson(res, decision.status, { error: 'atenea/blocked', reason: decision.reason })
    const extraHeaders = auth.cookie === undefined ? {} : { 'set-cookie': auth.cookie }
    const checked = await guard.request(req, url, auth.session)
    if (checked.refuse !== undefined) return sendJson(res, checked.refuse.status, checked.refuse.body, extraHeaders)
    hold(auth.session, res, 'close')
    await forwardHttp(req, res, {
      link,
      agent,
      path: upstreamPath(url),
      headersFor: headersFor(req, auth.session),
      extraHeaders,
      body: checked.body,
      transform: checked.transform,
      onStatus: checked.onStatus,
    })
  }

  async function handle(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      if (!(error instanceof DshUnavailable)) log(`gateway: request failed: ${error?.message ?? error}`)
      else log(`gateway: ${error.message}`)
      if (res.headersSent) res.destroy()
      else sendJson(res, error instanceof DshUnavailable ? 503 : 502, { error: 'atenea/upstream' })
    }
  }

  async function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy())
    try {
      const url = parse(req)
      if (url === null || !ownHost(req)) return refuse(socket, 400, 'Bad Request')
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(socket, 400, 'Bad Request')
      const auth = await authenticate(req)
      if (auth.failure === 'denied') return refuse(socket, 403, 'Forbidden')
      if (auth.failure === 'unavailable') return refuse(socket, 503, 'Service Unavailable')
      if (auth.failure !== undefined) return refuse(socket, 401, 'Unauthorized')
      if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden')
      const decision = decide({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, upgrade: true }, config)
      if (!decision.allow) return refuse(socket, decision.status, 'Refused')
      hold(auth.session, socket, 'close')
      const { session } = auth
      await forwardUpgrade(req, socket, head, {
        link,
        path: upstreamPath(url),
        headersFor: headersFor(req, session),
        decide: event => guard.streamMessage(session, event),
      })
    } catch (error) {
      log(`gateway: WebSocket failed: ${error?.message ?? error}`)
      refuse(socket, error instanceof DshUnavailable ? 503 : 502, 'Bad Gateway')
    }
  }

  // Sessions with an open stream are checked here too, so a suspended account loses its
  // WebSockets within a minute even when it sends no requests.
  async function sweep() {
    sessions.sweep()
    sessionAccess.sweep()
    prunePendingLogins()
    await Promise.all(sessions.all().filter(session => session.live.size > 0).map(async (session) => {
      try {
        await freshen(session)
      } catch (error) {
        if (error instanceof AccessDenied) endSession(session, 'denied')
        else if (error instanceof SessionExpired) endSession(session, 'expired')
        else if (error instanceof AccessUnavailable) {
          for (const connection of session.live) connection.destroy()
        } else log(`gateway: session check failed: ${error?.message ?? error}`)
      }
    }))
  }

  const server = http.createServer(handle)
  server.on('upgrade', upgrade)
  // Uploads to dsh may be large and slow; the headers still have to arrive promptly.
  server.requestTimeout = 30 * 60_000

  let timer = null
  let warming = true

  // Takes the owner cookie before the first visitor needs it; requests also take it on demand.
  async function warm() {
    let delay = 1_000
    let last = ''
    while (warming && !link.ready) {
      try {
        await link.cookie()
      } catch (error) {
        if (error.message !== last) log(`gateway: waiting for dsh web: ${error.message}`)
        last = error.message
        await new Promise(resolve => setTimeout(resolve, delay).unref())
        delay = Math.min(delay * 2, 30_000)
      }
    }
  }

  return {
    server,
    sessions,
    sessionAccess,
    link,
    sweep,
    listen(port = config.port, host = config.host) {
      timer = setInterval(() => { sweep().catch(error => log(`gateway: sweep failed: ${error?.message ?? error}`)) }, SWEEP_MS)
      timer.unref()
      warm()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server.address()))
      })
    },
    async close() {
      warming = false
      clearInterval(timer)
      for (const session of sessions.all()) sessions.end(session, 'shutdown')
      const closed = new Promise(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      agent.destroy()
    },
  }
}
