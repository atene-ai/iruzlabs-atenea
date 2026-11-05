// Auth: corporate single sign-on (Google Workspace, Microsoft Entra ID) in front of Atenea.
// The sign-in is an OAuth 2.0 authorization-code flow with PKCE on a loopback redirect
// (RFC 8252). The host decides who is let in; the client only renders the gate.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const DEFAULT_DOMAINS = ['iruzlabs.com', 'azurylabs.online']

const CALLBACK_PATH = '/auth/callback'
const FLOW_TIMEOUT_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const CLOCK_SKEW_MS = 60_000
const DEFAULT_SESSION_HOURS = 24 * 7
export const AUTH_ENDPOINTS = ['auth-view', 'auth-start', 'auth-cancel', 'auth-sign-out', 'auth-dev-login']

export function isAllowedDomain(email, allowed = DEFAULT_DOMAINS) {
  if (typeof email !== 'string') return false
  const parts = email.trim().toLowerCase().split('@')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return false
  const domain = parts[1]
  return allowed.some((entry) => {
    const d = entry.toLowerCase()
    return domain === d || domain.endsWith(`.${d}`)
  })
}

const list = value => (Array.isArray(value) ? value : String(value ?? '').split(','))
  .map(item => String(item).trim().toLowerCase())
  .filter(Boolean)

// Plugin config wins over the environment, so a packaged app can pin its own values.
export function authSettings(config = {}, env = process.env) {
  const domains = list(config.authDomains ?? env.ATENEA_AUTH_DOMAINS)
  const hours = Number(config.authSessionHours ?? env.ATENEA_AUTH_SESSION_HOURS)
  return {
    required: config.authRequired ?? env.ATENEA_AUTH_REQUIRED !== '0',
    domains: domains.length > 0 ? domains : DEFAULT_DOMAINS,
    devLogin: config.authDevLogin ?? env.ATENEA_AUTH_DEV_LOGIN === '1',
    sessionMs: (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_HOURS) * 3_600_000,
    google: {
      clientId: config.googleClientId ?? env.ATENEA_GOOGLE_CLIENT_ID,
      // Google's "Desktop app" clients still send their (non-confidential) secret.
      clientSecret: config.googleClientSecret ?? env.ATENEA_GOOGLE_CLIENT_SECRET,
    },
    microsoft: {
      clientId: config.microsoftClientId ?? env.ATENEA_MICROSOFT_CLIENT_ID,
      tenants: list(config.microsoftTenants ?? env.ATENEA_MICROSOFT_TENANT_ID),
    },
  }
}

class Denied extends Error {
  constructor(email) {
    super('Account not allowed')
    this.email = email
  }
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// The ID token comes straight from the provider's token endpoint over TLS, so its claims
// are read without checking the signature (OpenID Connect Core 3.1.3.7).
export function idTokenClaims(token) {
  const payload = String(token ?? '').split('.')[1]
  if (!payload) throw new Error('The provider sent no ID token')
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('The provider sent an unreadable ID token')
  }
}

function checkIdToken(claims, clientId, issuerOk, now = Date.now()) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(clientId)) throw new Error('The ID token was issued for another app')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - CLOCK_SKEW_MS) throw new Error('The ID token has expired')
  if (!issuerOk(claims.iss)) throw new Error('The ID token comes from an unexpected issuer')
}

async function fetchJson(request, url, init = {}) {
  const response = await request(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok && body.error === undefined) throw new Error(`${new URL(url).host} answered ${response.status}`)
  return body
}

export const PROVIDERS = {
  google: {
    configured: settings => Boolean(settings.google.clientId),
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    tokenParams: ({ google }) => ({ client_id: google.clientId, ...(google.clientSecret ? { client_secret: google.clientSecret } : {}) }),
    authorizeUrl(settings, { redirectUri, state, challenge }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: settings.google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Only a hint for the account picker; `hd` is checked again on the ID token.
        // `*` keeps every Workspace domain selectable when more than one is allowed.
        hd: settings.domains.length === 1 ? settings.domains[0] : '*',
        prompt: 'select_account',
      })
      return url.toString()
    },
    async profile(tokens, settings, _request, now) {
      const claims = idTokenClaims(tokens.id_token)
      checkIdToken(claims, settings.google.clientId, iss => iss === 'https://accounts.google.com' || iss === 'accounts.google.com', now)
      // A consumer Google account can use a corporate address as its login; only
      // Workspace accounts carry `hd`, and only a verified address is trusted.
      const workspace = typeof claims.hd === 'string' && isAllowedDomain(`x@${claims.hd}`, settings.domains)
      if (claims.email_verified !== true || !workspace || !isAllowedDomain(claims.email, settings.domains)) throw new Denied(claims.email)
      return { name: claims.name || claims.email, email: claims.email, avatar: claims.picture ?? null }
    },
  },
  microsoft: {
    configured: settings => Boolean(settings.microsoft.clientId),
    // `organizations` keeps personal Microsoft accounts out: those can be opened with any address.
    authority: ({ microsoft }) => (microsoft.tenants.length === 1 ? microsoft.tenants[0] : 'organizations'),
    tokenUrl(settings) {
      return `https://login.microsoftonline.com/${encodeURIComponent(this.authority(settings))}/oauth2/v2.0/token`
    },
    tokenParams: ({ microsoft }) => ({ client_id: microsoft.clientId }),
    authorizeUrl(settings, { redirectUri, state, challenge }) {
      const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(this.authority(settings))}/oauth2/v2.0/authorize`)
      url.search = new URLSearchParams({
        client_id: settings.microsoft.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile User.Read',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })
      return url.toString()
    },
    async profile(tokens, settings, request, now) {
      const claims = idTokenClaims(tokens.id_token)
      checkIdToken(claims, settings.microsoft.clientId, iss => typeof claims.tid === 'string' && iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`, now)
      const { tenants } = settings.microsoft
      if (tenants.length > 0 && !tenants.includes(String(claims.tid).toLowerCase())) throw new Denied(claims.preferred_username)
      const me = await fetchJson(request, 'https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      // The domain check reads the UPN, whose suffix must be a domain the tenant has
      // verified. `mail` is free text any tenant admin can set (the "nOAuth" flaw).
      const upn = me.userPrincipalName
      if (!isAllowedDomain(upn, settings.domains)) throw new Denied(me.mail || upn)
      return { name: me.displayName || upn, email: me.mail && isAllowedDomain(me.mail, settings.domains) ? me.mail : upn, avatar: null }
    },
  },
}

async function exchangeCode(provider, settings, request, { code, verifier, redirectUri }) {
  const tokens = await fetchJson(request, provider.tokenUrl(settings), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...provider.tokenParams(settings), code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }),
  })
  if (!tokens.access_token || !tokens.id_token) throw new Error(tokens.error_description || tokens.error || 'The provider sent no tokens')
  return tokens
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

function page(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The callback URL carries the authorization code.
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    // Lets the server close as soon as this answer is out.
    Connection: 'close',
  })
  res.end(html)
}

const card = (border, icon, iconColor, title, titleColor, body) => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Atenea · ${title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b0f19;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;max-width:420px;padding:36px;background:#131b2e;border-radius:16px;border:1px solid ${border};box-shadow:0 20px 40px rgba(0,0,0,0.5);">
    <div style="width:48px;height:48px;margin:0 auto 16px;border-radius:50%;background:${iconColor}26;display:flex;align-items:center;justify-content:center;color:${iconColor};font-size:24px;">${icon}</div>
    <h2 style="color:${titleColor};margin:0 0 8px;font-size:20px;">${title}</h2>
    ${body}
  </div>
</body>
</html>`

export const successPage = email => card('#1e293b', '✓', '#38bdf8', 'Autenticación exitosa', '#f8fafc', `
    <p style="color:#94a3b8;font-size:14px;margin:0 0 18px;">Sesión iniciada como <strong style="color:#38bdf8;">${escapeHtml(email)}</strong>.</p>
    <p style="color:#64748b;font-size:12px;margin:0;">Puedes cerrar esta ventana y volver a <strong>Atenea</strong>.</p>`)

export const deniedPage = (email, domains) => card('#331515', '✕', '#ef4444', 'Acceso denegado', '#ef4444', `
    <p style="color:#94a3b8;font-size:14px;margin:0 0 16px;">La cuenta <strong style="color:#fff;">${escapeHtml(email || 'desconocida')}</strong> no pertenece a la organización.</p>
    <p style="color:#cbd5e1;font-size:13px;background:rgba(0,0,0,0.3);padding:10px 14px;border-radius:8px;margin:0 0 16px;">Solo se permiten cuentas corporativas de: <br><strong>${domains.map(d => escapeHtml(`@${d}`)).join(' o ')}</strong></p>
    <p style="color:#64748b;font-size:12px;margin:0;">Vuelve a Atenea para iniciar sesión con una cuenta autorizada.</p>`)

export const errorPage = message => card('#331515', '!', '#f59e0b', 'Error de autenticación', '#f8fafc', `
    <p style="color:#94a3b8;font-size:14px;margin:0 0 16px;">No se pudo completar el inicio de sesión.</p>
    ${message ? `<p style="color:#cbd5e1;font-size:12px;background:rgba(0,0,0,0.3);padding:10px 14px;border-radius:8px;margin:0;">${escapeHtml(message)}</p>` : ''}`)

export function install(rt) {
  const { state } = rt
  const settings = authSettings(rt.config ?? {})
  const request = rt.authFetch ?? fetch
  let flow = null

  const closeFlow = (target = flow) => {
    if (target === null) return
    clearTimeout(target.timer)
    target.server.close()
    if (flow === target) flow = null
  }

  const currentUser = (now = Date.now()) => {
    const user = state.user
    if (!user || typeof user.loggedInAt !== 'number') return null
    if (now - user.loggedInAt >= settings.sessionMs) return null
    // A changed domain list or a turned-off direct sign-in ends the sessions they let in.
    if (!isAllowedDomain(user.email, settings.domains)) return null
    if (user.dev === true && !settings.devLogin) return null
    return user
  }

  const authView = () => ({
    required: settings.required,
    user: currentUser(),
    domains: settings.domains,
    providers: ['google', 'microsoft'],
    googleConfigured: PROVIDERS.google.configured(settings),
    microsoftConfigured: PROVIDERS.microsoft.configured(settings),
    devLogin: settings.devLogin,
  })

  const authLocked = () => settings.required && currentUser() === null

  const signIn = async (user) => {
    state.user = { ...user, loggedInAt: Date.now() }
    await rt.save()
  }

  const answer = async (current, req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return page(res, 404, errorPage(''))
    // Any local web page can reach this port; a request without this flow's state must
    // neither end the flow nor reach the token exchange.
    if (url.searchParams.get('state') !== current.stateToken || current.used) return page(res, 400, errorPage(''))
    current.used = true
    try {
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      if (error || !code) throw new Error(url.searchParams.get('error_description') || error || 'No authorization code')
      const provider = PROVIDERS[current.provider]
      const tokens = await exchangeCode(provider, settings, request, { code, verifier: current.verifier, redirectUri: current.redirectUri })
      const profile = await provider.profile(tokens, settings, request)
      await signIn({ ...profile, provider: current.provider })
      page(res, 200, successPage(profile.email))
    } catch (err) {
      if (err instanceof Denied) {
        page(res, 403, deniedPage(err.email, settings.domains))
      } else {
        const message = String(err?.message ?? err).slice(0, 300)
        rt.warn?.('ds-bot: corporate sign-in failed: %s', message)
        page(res, 500, errorPage(message))
      }
    } finally {
      closeFlow(current)
    }
  }

  const endpoints = {
    async 'auth-view'() {
      return authView()
    },

    async 'auth-start'(body) {
      const id = body.provider === 'microsoft' ? 'microsoft' : 'google'
      closeFlow()
      if (!PROVIDERS[id].configured(settings)) return { configured: false, provider: id }
      const { verifier, challenge } = pkcePair()
      const server = createServer()
      const current = { provider: id, server, verifier, stateToken: randomBytes(16).toString('base64url'), used: false, timer: null, redirectUri: '' }
      server.on('request', (req, res) => void answer(current, req, res))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      current.redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`
      current.timer = setTimeout(() => closeFlow(current), FLOW_TIMEOUT_MS)
      current.timer.unref?.()
      flow = current
      return { configured: true, provider: id, authUrl: PROVIDERS[id].authorizeUrl(settings, { redirectUri: current.redirectUri, state: current.stateToken, challenge }) }
    },

    async 'auth-cancel'() {
      closeFlow()
      return { ok: true }
    },

    async 'auth-sign-out'() {
      closeFlow()
      state.user = null
      await rt.save()
      return authView()
    },

    // Signs in on the address alone, without asking the provider: for development only.
    async 'auth-dev-login'(body) {
      if (!settings.devLogin) throw new Error('Direct sign-in is turned off; sign in with Google or Microsoft')
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!email) throw new Error('Enter your corporate email')
      if (!isAllowedDomain(email, settings.domains)) throw new Error(`Only accounts from ${settings.domains.map(d => `@${d}`).join(', ')} can sign in`)
      const provider = body.provider === 'microsoft' ? 'microsoft' : 'google'
      const name = String(body.name ?? '').trim().slice(0, 120) || email.split('@')[0]
      await signIn({ name, email, avatar: null, provider, dev: true })
      return authView()
    },
  }

  const authEndpoint = (endpoint, body) => endpoints[endpoint](body ?? {})

  rt.ctx?.effect?.(() => () => closeFlow(), 'ds-bot: auth')

  Object.assign(rt, { authView, authEndpoint, authLocked, authDomains: settings.domains })
}
