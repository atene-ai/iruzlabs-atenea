// "My CRM account": a staff member links their own CRM user through the CRM's Cognito
// Hosted UI (authorization code with S256 PKCE). The refresh token is kept per staff id,
// sealed with AES-256-GCM under ATENEA_CRM_TOKEN_KEY, in a file only the server user can
// read. These helpers have no state of their own; crm.js wires them in.
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { replaceFile } from './files.js'

const KEY_BYTES = 32
const IV_BYTES = 12
const SCOPES = 'openid email profile'

// The key is 32 random bytes, written as base64 (with or without padding) or as hex.
export function parseTokenKey(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return undefined
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : /^[A-Za-z0-9+/_-]{43}=?$/.test(value) ? Buffer.from(value, 'base64') : undefined
  if (key?.length !== KEY_BYTES) throw new Error('ATENEA_CRM_TOKEN_KEY must be 32 random bytes, as base64 or hex')
  return key
}

// The staff id is the additional data, so a sealed token moved to someone else's entry
// does not open.
const aad = staffId => Buffer.from(`ds-bot crm link\n${staffId}`, 'utf8')

export function seal(key, staffId, payload) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(staffId))
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function unseal(key, staffId, sealed) {
  if (sealed?.v !== 1) throw new Error('unknown sealed format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAAD(aad(staffId))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
  return JSON.parse(text)
}

// RFC 7636: a 43-character verifier from 32 random bytes, and its S256 challenge.
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export const newState = () => randomBytes(24).toString('base64url')

const origin = domain => String(domain).replace(/\/+$/, '')

export function authorizeUrl({ domain, clientId, redirectUri }, { state, challenge }) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${origin(domain)}/oauth2/authorize?${query}`
}

export const tokenUrl = ({ domain }) => `${origin(domain)}/oauth2/token`
export const revokeUrl = ({ domain }) => `${origin(domain)}/oauth2/revoke`

// The claims of a JWT, unchecked: an ID token that came straight from the pool's token
// endpoint over TLS needs no signature check of its own (OpenID Connect Core 3.1.3.7).
export function jwtClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return claims !== null && typeof claims === 'object' ? claims : undefined
  } catch {
    return undefined
  }
}

// Whether an ID token from the token endpoint is one of the CRM pool's, for this client.
export function idTokenProblem(claims, { userPoolId, region, clientId }, now = Date.now()) {
  if (claims === undefined) return 'unreadable ID token'
  if (claims.token_use !== 'id') return 'not an ID token'
  if (userPoolId && region && claims.iss !== `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`) return 'ID token from another pool'
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (clientId && !audiences.includes(clientId)) return 'ID token for another client'
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return 'expired ID token'
  if (typeof claims.sub !== 'string' || claims.sub === '') return 'ID token without a subject'
  return undefined
}

// The links file: `{ version: 1, links: { <staffId>: { sealed, linkedAt } } }`, mode 0600.
export function createLinkStore({ path, key, warn = () => {} }) {
  let links
  let writing = Promise.resolve()

  const loaded = () => {
    if (links !== undefined) return links
    links = {}
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      for (const [staffId, entry] of Object.entries(saved?.links ?? {})) {
        if (staffId !== '__proto__' && entry?.sealed?.v === 1) links[staffId] = { sealed: entry.sealed, linkedAt: Number(entry.linkedAt) || 0 }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('ds-bot: CRM links file %s not read: %s', path, error?.message ?? error)
    }
    return links
  }

  const persist = () => {
    const snapshot = JSON.stringify({ version: 1, links: loaded() })
    const temp = `${path}.${process.pid}.tmp`
    // A failed write fails its own caller, not the writes queued after it.
    writing = writing.catch(() => {}).then(async () => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        chmodSync(temp, 0o600)
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        warn('ds-bot: CRM links file %s not written: %s', path, error?.message ?? error)
        throw error
      }
    })
    return writing
  }

  return {
    has: staffId => Object.hasOwn(loaded(), staffId),
    linkedAt: staffId => loaded()[staffId]?.linkedAt,
    // The payload, or undefined when there is no link or it does not open with this key.
    read(staffId) {
      const entry = loaded()[staffId]
      if (entry === undefined || key === undefined) return undefined
      try {
        return unseal(key, staffId, entry.sealed)
      } catch {
        warn('ds-bot: the CRM link of %s does not open with the current key', staffId)
        return undefined
      }
    },
    async write(staffId, payload) {
      if (key === undefined) throw new Error('ATENEA_CRM_TOKEN_KEY is not set')
      loaded()[staffId] = { sealed: seal(key, staffId, payload), linkedAt: Date.now() }
      await persist()
    },
    async remove(staffId) {
      if (!Object.hasOwn(loaded(), staffId)) return false
      delete links[staffId]
      await persist()
      return true
    },
    settled: () => writing.catch(() => {}),
  }
}
