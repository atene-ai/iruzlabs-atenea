// Cognito ID token verification against the pool's JWKS, and the HS256 identity token the
// gateway signs for ds-bot.
import { createHmac, createPublicKey, verify } from 'node:crypto'

const CLOCK_SKEW_S = 60
// A token with an unknown kid fetches the key set again, at most this often: Cognito
// rotates keys rarely, and a burst of bad tokens must not turn into a burst of fetches.
const JWKS_REFETCH_MIN_MS = 10_000
const FETCH_TIMEOUT_MS = 10_000

export class TokenError extends Error {}

const json = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

function split(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) throw new TokenError('malformed token')
  try {
    return { header: json(parts[0]), claims: json(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') }
  } catch {
    throw new TokenError('malformed token')
  }
}

export function createJwks(url, { fetch = globalThis.fetch, now = Date.now } = {}) {
  let keys = null
  let fetchedAt = -Infinity
  let pending = null

  const load = () => {
    pending ??= (async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) throw new TokenError(`JWKS answered ${response.status}`)
        const body = await response.json()
        if (!Array.isArray(body?.keys)) throw new TokenError('JWKS has no keys')
        keys = body.keys
        fetchedAt = now()
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const find = kid => keys?.find(key => key.kid === kid && key.kty === 'RSA' && (key.use === undefined || key.use === 'sig'))

  return {
    async key(kid) {
      if (keys === null) await load()
      let jwk = find(kid)
      if (jwk === undefined && now() - fetchedAt >= JWKS_REFETCH_MIN_MS) {
        await load()
        jwk = find(kid)
      }
      if (jwk === undefined) throw new TokenError('unknown signing key')
      return createPublicKey({ key: jwk, format: 'jwk' })
    },
  }
}

// Checks everything the gateway relies on: an RS256 signature by a pool key, the pool as
// issuer, this app client as audience, an ID (not access) token that has not expired,
// and a verified email address.
export async function verifyIdToken(token, { jwks, issuer, clientId, nonce, now = Date.now }) {
  const { header, claims, signed, signature } = split(token)
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new TokenError('unexpected token algorithm')
  const key = await jwks.key(header.kid)
  if (!verify('RSA-SHA256', Buffer.from(signed), key, signature)) throw new TokenError('bad token signature')
  const seconds = Math.floor(now() / 1000)
  if (claims.iss !== issuer) throw new TokenError('unexpected issuer')
  if (claims.aud !== clientId) throw new TokenError('unexpected audience')
  if (claims.token_use !== 'id') throw new TokenError('not an ID token')
  if (typeof claims.exp !== 'number' || claims.exp <= seconds) throw new TokenError('token expired')
  if (typeof claims.iat === 'number' && claims.iat > seconds + CLOCK_SKEW_S) throw new TokenError('token issued in the future')
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new TokenError('token has no subject')
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new TokenError('email not verified')
  if (nonce !== undefined && claims.nonce !== nonce) throw new TokenError('nonce mismatch')
  return claims
}

export function signHs256(claims, secret) {
  const signed = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`
}
