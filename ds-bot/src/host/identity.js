// Identity: who sent a request when several staff members share one Atenea server.
// The gateway in front of DSH Web signs each request's identity as a compact JWS
// (HS256) in `x-atenea-identity`; the host checks it on every /api/bot request and
// runs the request with it in an AsyncLocalStorage context, so every module down the
// call can ask who is acting without threading an argument through the team code.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const IDENTITY_HEADER = 'x-atenea-identity'
export const SLA_TOKEN_HEADER = 'x-atenea-sla-token'
export const STAFF_ROLES = ['superadmin', 'product_lead', 'support']
export const AGENT_ROLES = ['owner', 'editor', 'reader']
const ISSUER = 'atenea-gateway'
const AUDIENCE = 'ds-bot'
// The gateway mints a token per request; one that lives longer was not minted for one.
const MAX_LIFETIME_S = 120
const LEEWAY_S = 10
// HS256 with a shorter key is guessable offline from one captured token.
const MIN_SECRET = 32
const PART = /^[A-Za-z0-9_-]+$/

const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

// Plugin config wins over the environment, as in auth.js.
export function multiuserSettings(config = {}, env = process.env) {
  return {
    multiuser: config.multiuser ?? env.ATENEA_MULTIUSER === '1',
    secret: config.identitySecret ?? env.ATENEA_IDENTITY_SECRET,
    slaUrl: config.slaUrl ?? env.SLA_URL,
  }
}

// Returns `{ identity }` or `{ error }`, never throws: the reason is for the log only.
export function verifyIdentity(token, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return { error: `ATENEA_IDENTITY_SECRET must have at least ${MIN_SECRET} characters` }
  if (typeof token !== 'string' || token.length === 0) return { error: 'no identity' }
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every(part => PART.test(part))) return { error: 'malformed identity' }
  const [head, body, signature] = parts
  let header
  let claims
  try {
    header = decode(head)
    claims = decode(body)
  } catch {
    return { error: 'unreadable identity' }
  }
  // Only HS256: a token naming another algorithm (or `none`) is refused before any key use.
  if (header?.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT')) return { error: 'unexpected identity algorithm' }
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'bad identity signature' }
  if (claims === null || typeof claims !== 'object') return { error: 'unreadable identity' }
  if (claims.iss !== ISSUER) return { error: 'identity from an unexpected issuer' }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(AUDIENCE)) return { error: 'identity for another audience' }
  const seconds = now / 1000
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S <= seconds) return { error: 'expired identity' }
  if (typeof claims.iat !== 'number' || claims.iat - LEEWAY_S > seconds) return { error: 'identity issued in the future' }
  if (claims.exp - claims.iat > MAX_LIFETIME_S) return { error: 'identity lives too long' }
  const id = text(claims.sub, 200)
  if (id === '') return { error: 'identity without a subject' }
  if (!STAFF_ROLES.includes(claims.role)) return { error: 'identity with an unknown role' }
  const agents = {}
  if (claims.agents !== null && typeof claims.agents === 'object' && !Array.isArray(claims.agents)) {
    for (const [botId, role] of Object.entries(claims.agents)) {
      if (AGENT_ROLES.includes(role) && botId !== '__proto__') agents[botId] = role
    }
  }
  const email = text(claims.email, 320)
  return {
    identity: Object.freeze({
      id,
      email,
      name: text(claims.name, 120) || email || id,
      role: claims.role,
      agents: Object.freeze(agents),
      iat: claims.iat,
      exp: claims.exp,
    }),
  }
}

export function install(rt) {
  const settings = multiuserSettings(rt.config ?? {})
  const requests = new AsyncLocalStorage()
  // A refused request is logged once a minute per reason, so a flood cannot fill the log.
  const warned = new Map()
  const warnSometimes = (reason, now) => {
    if (now - (warned.get(reason) ?? -Infinity) < 60_000) return
    warned.set(reason, now)
    rt.warn?.('ds-bot: request refused: %s', reason)
  }

  // `{ identity, slaToken }` for a request that carries a valid identity, else `{ error }`.
  // The SLA token is the person's own Cognito token, passed on only to SLA.
  function identify(request, now = Date.now()) {
    const checked = verifyIdentity(request.headers.get(IDENTITY_HEADER) ?? '', settings.secret, now)
    if (checked.error !== undefined) {
      warnSometimes(checked.error, now)
      return checked
    }
    const raw = request.headers.get(SLA_TOKEN_HEADER) ?? ''
    const slaToken = raw.length > 0 && raw.length <= 8192 && !/\s/.test(raw) ? raw : undefined
    return { identity: checked.identity, slaToken }
  }

  const runAs = (context, run) => requests.run(context, run)
  const requestContext = () => requests.getStore()
  const viewer = () => requests.getStore()?.identity

  Object.assign(rt, { multiuser: settings.multiuser === true, multiuserSettings: settings, identify, runAs, requestContext, viewer })
}
