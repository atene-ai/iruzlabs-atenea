import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { createJwks, signHs256, TokenError, verifyIdToken } from '../src/jwt.js'
import { CLIENT_ID, createClock, createCognito, createKey, fakeFetch, ISSUER, signRs256 } from './helpers.js'

function setup() {
  const clock = createClock()
  const cognito = createCognito(clock)
  const jwks = createJwks(`${ISSUER}/.well-known/jwks.json`, { fetch: fakeFetch(cognito.handle), now: clock.now })
  const verify = (token, extra = {}) => verifyIdToken(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID, now: clock.now, ...extra })
  return { clock, cognito, verify }
}

const rejects = (promise, pattern) => assert.rejects(promise, error => error instanceof TokenError && pattern.test(error.message))

test('a Cognito ID token for this client verifies', async () => {
  const { cognito, verify } = setup()
  const claims = await verify(cognito.idToken())
  assert.equal(claims.sub, 'cognito-sub-1')
  assert.equal(claims.email, 'ana@example.com')
})

test('the issuer, audience and token use must match', async () => {
  const { cognito, verify } = setup()
  await rejects(verify(cognito.idToken({ iss: 'https://cognito-idp.mx-central-1.amazonaws.com/mx-central-1_other' })), /issuer/)
  await rejects(verify(cognito.idToken({ aud: 'another-client' })), /audience/)
  await rejects(verify(cognito.idToken({ token_use: 'access' })), /not an ID token/)
})

test('an expired token is refused', async () => {
  const { clock, cognito, verify } = setup()
  const token = cognito.idToken()
  await verify(token)
  clock.advance(3600 * 1000)
  await rejects(verify(token), /expired/)
})

test('an unverified email address is refused', async () => {
  const { cognito, verify } = setup()
  await rejects(verify(cognito.idToken({ email_verified: false })), /email not verified/)
  await rejects(verify(cognito.idToken({ email_verified: undefined })), /email not verified/)
  assert.ok(await verify(cognito.idToken({ email_verified: 'true' })))
})

test('the nonce is checked when one was sent', async () => {
  const { cognito, verify } = setup()
  await verify(cognito.idToken({ nonce: 'n-1' }), { nonce: 'n-1' })
  await rejects(verify(cognito.idToken({ nonce: 'n-2' }), { nonce: 'n-1' }), /nonce/)
})

test('a forged or downgraded signature is refused', async () => {
  const { cognito, verify } = setup()
  const stranger = createKey('key-1')
  await rejects(verify(cognito.idToken({}, stranger)), /signature/)
  const [, payload] = cognito.idToken().split('.')
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url')}.${payload}.`
  await rejects(verify(none), /malformed|algorithm/)
  const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'key-1' })).toString('base64url')
  const hs = `${hsHeader}.${payload}.${createHmac('sha256', 'guess').update(`${hsHeader}.${payload}`).digest('base64url')}`
  await rejects(verify(hs), /algorithm/)
  await rejects(verify('not.a.token'), /malformed/)
})

test('a new signing key is fetched again when its kid is unknown', async () => {
  const { clock, cognito, verify } = setup()
  await verify(cognito.idToken())
  assert.equal(cognito.jwksFetches, 1)
  cognito.rotateKey()
  clock.advance(60_000)
  await verify(cognito.idToken())
  assert.equal(cognito.jwksFetches, 2)
  // A known kid needs no fetch, and an unknown one right after a fetch waits its turn.
  await verify(cognito.idToken({}, cognito.keys[0]))
  await rejects(verify(signRs256({ alg: 'RS256', kid: 'key-9' }, { iss: ISSUER }, createKey('key-9').privateKey)), /unknown signing key/)
  assert.equal(cognito.jwksFetches, 2)
})

test('the identity token is an HS256 JWS over the claims', () => {
  const claims = { iss: 'atenea-gateway', aud: 'ds-bot', sub: 'staff-1', iat: 100, exp: 220 }
  const token = signHs256(claims, 'test-secret-for-identity-token-000')
  const [header, payload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), claims)
  assert.equal(signature, createHmac('sha256', 'test-secret-for-identity-token-000').update(`${header}.${payload}`).digest('base64url'))
})
