// Cognito Hosted UI: authorization code flow with PKCE (RFC 7636), refresh and revocation.
import { createHash, randomBytes } from 'node:crypto'

const FETCH_TIMEOUT_MS = 15_000
const SCOPES = 'openid email profile'

export class OidcError extends Error {
  constructor(message, { code } = {}) {
    super(message)
    this.code = code
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export function pkcePair() {
  const verifier = randomToken(32)
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export const redirectUri = publicUrl => `${publicUrl}/auth/callback`

export function authorizeUrl({ cognito, publicUrl }, { state, challenge, nonce }) {
  const url = new URL('/oauth2/authorize', cognito.domain)
  url.search = new URLSearchParams({
    client_id: cognito.clientId,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri(publicUrl),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return url.href
}

export function logoutUrl({ cognito, publicUrl }) {
  const url = new URL('/logout', cognito.domain)
  url.search = new URLSearchParams({ client_id: cognito.clientId, logout_uri: `${publicUrl}/` })
  return url.href
}

// A confidential client authenticates with HTTP Basic (client_secret_basic); a public one
// names itself in the body and relies on PKCE.
function clientAuth(cognito, body) {
  if (cognito.clientSecret === undefined) {
    body.set('client_id', cognito.clientId)
    return {}
  }
  const basic = Buffer.from(`${encodeURIComponent(cognito.clientId)}:${encodeURIComponent(cognito.clientSecret)}`).toString('base64')
  return { authorization: `Basic ${basic}` }
}

async function post(fetch, cognito, path, params) {
  const body = new URLSearchParams(params)
  const response = await fetch(new URL(path, cognito.domain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...clientAuth(cognito, body) },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new OidcError(`Cognito ${path} answered ${response.status}`, { code: typeof data.error === 'string' ? data.error : undefined })
  return data
}

export async function exchangeCode({ cognito, publicUrl }, { code, verifier }, fetch = globalThis.fetch) {
  const tokens = await post(fetch, cognito, '/oauth2/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(publicUrl),
  })
  if (typeof tokens.id_token !== 'string') throw new OidcError('Cognito sent no ID token')
  return tokens
}

export async function refreshTokens({ cognito }, refreshToken, fetch = globalThis.fetch) {
  const tokens = await post(fetch, cognito, '/oauth2/token', { grant_type: 'refresh_token', refresh_token: refreshToken })
  if (typeof tokens.id_token !== 'string') throw new OidcError('Cognito sent no ID token')
  return tokens
}

export async function revokeToken({ cognito }, refreshToken, fetch = globalThis.fetch) {
  await post(fetch, cognito, '/oauth2/revoke', { token: refreshToken })
}
