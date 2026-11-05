import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ABSOLUTE_MS, createSessionStore, IDLE_MS, ROTATE_MS, ROTATION_GRACE_MS, SESSION_COOKIE } from '../src/sessions.js'
import { createClock } from './helpers.js'

const valueOf = setCookie => setCookie.split(';', 1)[0].slice(`${SESSION_COOKIE}=`.length)

function setup() {
  const clock = createClock()
  const store = createSessionStore({ now: clock.now })
  return { clock, store }
}

test('the cookie is signed, httpOnly, Secure and SameSite=Lax for the absolute lifetime', () => {
  const { store } = setup()
  const session = store.create({ user: 'ana' })
  const cookie = store.cookie(session)
  assert.match(cookie, /^__Host-atenea_session=[\w-]+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/)
  assert.equal(store.find(valueOf(cookie)), session)
})

test('a tampered or unsigned cookie finds nothing', () => {
  const { store } = setup()
  const value = valueOf(store.cookie(store.create({})))
  const [sid, mac] = value.split('.')
  assert.equal(store.find(`${sid}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`), null)
  assert.equal(store.find(sid), null)
  assert.equal(store.find(`x${sid}.${mac}`), null)
  // Another process's key signs other cookies.
  assert.equal(createSessionStore().find(value), null)
})

test('the id rotates, and the old id works only during the grace period', () => {
  const { clock, store } = setup()
  const session = store.create({})
  const first = valueOf(store.cookie(session))
  clock.advance(ROTATE_MS - 1)
  assert.equal(store.touch(session), false)
  clock.advance(1)
  assert.equal(store.touch(session), true)
  const second = valueOf(store.cookie(session))
  assert.notEqual(first, second)
  assert.equal(store.find(second), session)
  assert.equal(store.find(first), session)
  clock.advance(ROTATION_GRACE_MS)
  assert.equal(store.find(first), null)
  assert.equal(store.find(second), session)
})

test('a session ends after 12 hours without requests', () => {
  const { clock, store } = setup()
  const session = store.create({})
  const value = valueOf(store.cookie(session))
  clock.advance(IDLE_MS - 1000)
  assert.equal(store.find(value), session)
  store.touch(session)
  const fresh = valueOf(store.cookie(session))
  clock.advance(IDLE_MS - 1000)
  assert.equal(store.find(fresh), session)
  clock.advance(1000)
  assert.equal(store.find(fresh), null)
  assert.equal(session.ended, 'expired')
})

test('a session ends after 7 days however active it is', () => {
  const { clock, store } = setup()
  const session = store.create({})
  for (let elapsed = 0; elapsed < ABSOLUTE_MS - IDLE_MS; elapsed += IDLE_MS / 2) {
    clock.advance(IDLE_MS / 2)
    store.touch(session)
  }
  const value = valueOf(store.cookie(session))
  assert.equal(store.find(value), session)
  clock.advance(ABSOLUTE_MS)
  assert.equal(store.find(value), null)
})

test('ending a session closes its streams and forgets its old ids', () => {
  const { clock, store } = setup()
  const session = store.create({})
  const old = valueOf(store.cookie(session))
  clock.advance(ROTATE_MS)
  store.touch(session)
  let destroyed = 0
  session.live.add({ destroy: () => { destroyed += 1 } })
  store.end(session, 'denied')
  assert.equal(destroyed, 1)
  assert.equal(store.find(old), null)
  assert.equal(store.find(valueOf(store.cookie(session))), null)
  assert.deepEqual(store.all(), [])
})

test('the sweep ends idle sessions', () => {
  const { clock, store } = setup()
  const idle = store.create({})
  clock.advance(IDLE_MS / 2)
  const active = store.create({})
  clock.advance(IDLE_MS / 2)
  store.sweep()
  assert.equal(idle.ended, 'expired')
  assert.equal(active.ended, null)
})
