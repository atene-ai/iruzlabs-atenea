// Server-side sessions behind a signed cookie. The store lives in memory: a gateway
// restart signs everyone out, which Cognito's own session turns into a quick sign-in.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { serializeCookie, clearCookie } from './cookies.js'

export const SESSION_COOKIE = 'atenea_session'
export const IDLE_MS = 12 * 3_600_000
export const ABSOLUTE_MS = 7 * 24 * 3_600_000
export const ROTATE_MS = 15 * 60_000
// Requests already in flight with the previous id (parallel fetches, a WebSocket
// reconnect) still find the session for this long after a rotation.
export const ROTATION_GRACE_MS = 60_000

export function createSessionStore({ now = Date.now, key = randomBytes(32) } = {}) {
  const sessions = new Map()
  const retired = new Map()

  const mac = sid => createHmac('sha256', key).update(sid).digest('base64url')
  const sign = sid => `${sid}.${mac(sid)}`

  function unsign(value) {
    const at = String(value ?? '').lastIndexOf('.')
    if (at <= 0) return null
    const sid = value.slice(0, at)
    const given = Buffer.from(value.slice(at + 1))
    const expected = Buffer.from(mac(sid))
    return given.length === expected.length && timingSafeEqual(given, expected) ? sid : null
  }

  const expired = (session, at = now()) => at - session.lastSeen >= IDLE_MS || at - session.createdAt >= ABSOLUTE_MS

  function end(session, reason) {
    if (session.ended) return
    session.ended = reason
    sessions.delete(session.sid)
    for (const [sid, entry] of retired) if (entry.session === session) retired.delete(sid)
    for (const socket of session.live) socket.destroy()
    session.live.clear()
  }

  return {
    create(data) {
      const at = now()
      const session = { ...data, sid: randomBytes(32).toString('base64url'), createdAt: at, lastSeen: at, rotatedAt: at, live: new Set(), ended: null }
      sessions.set(session.sid, session)
      return session
    },

    // The session a cookie value names, or null. A session past its idle or absolute
    // limit ends here, so it can never be used again.
    find(value) {
      const sid = unsign(value)
      if (sid === null) return null
      let session = sessions.get(sid)
      if (session === undefined) {
        const entry = retired.get(sid)
        if (entry === undefined || entry.until <= now()) return null
        session = entry.session
      }
      if (expired(session)) {
        end(session, 'expired')
        return null
      }
      return session
    },

    // Marks activity and rotates the id when it is due; true when the caller must send
    // the new cookie.
    touch(session) {
      const at = now()
      session.lastSeen = at
      if (at - session.rotatedAt < ROTATE_MS) return false
      const previous = session.sid
      session.sid = randomBytes(32).toString('base64url')
      session.rotatedAt = at
      sessions.delete(previous)
      sessions.set(session.sid, session)
      retired.set(previous, { session, until: at + ROTATION_GRACE_MS })
      return true
    },

    end,

    cookie(session) {
      return serializeCookie(SESSION_COOKIE, sign(session.sid), { maxAge: (session.createdAt + ABSOLUTE_MS - now()) / 1000 })
    },

    clearCookie: () => clearCookie(SESSION_COOKIE),

    sweep() {
      const at = now()
      for (const session of sessions.values()) if (expired(session, at)) end(session, 'expired')
      for (const [sid, entry] of retired) if (entry.until <= at) retired.delete(sid)
    },

    all: () => [...sessions.values()],
  }
}
