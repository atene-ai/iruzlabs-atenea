import { createElement as h, useEffect, useState } from 'react'
import { freePriority } from './surface.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// A shared Atenea server: several staff members use one team, and the host says
// per Bot and group chat what the signed-in person may do (`access`). Nothing here
// acts unless the roster says `multiuser`.

// The conversations the viewer may only read, each id (a Bot or a group, and every
// part of its chat) mapped to what the read-only composer says there. One object
// per conversation, so the composer chain hands the same `matched` for each part.
export function readOnlyTargets(roster) {
  const targets = new Map()
  if (roster?.multiuser !== true) return targets
  const add = (ids, matched) => {
    for (const id of ids) if (typeof id === 'string' && id !== '') targets.set(id, matched)
  }
  for (const bot of roster.bots ?? []) {
    if (bot?.access?.write === false) add([bot.id, bot.sessionId, ...(bot.parts ?? [])], { kind: 'bot', id: bot.id })
  }
  for (const room of roster.rooms ?? []) {
    if (room?.access?.write === false) add([room.id, room.sessionId, ...(room.ownParts ?? [])], { kind: 'room', id: room.id })
  }
  return targets
}

const targetsKey = targets => [...targets.entries()].map(([id, matched]) => `${id}:${matched.kind}`).sort().join(',')

// The composer chain's selector must be a pure function of the Session id, so the
// read-only ids are captured at registration, and the entry is registered again
// whenever they change. It goes ahead of every other composer takeover (a question
// card cannot be answered by a reader either).
export function installReadOnlyComposer(slots, roster, component, priority) {
  const name = 'conversation.composer'
  let key = ''
  let dispose
  const refresh = () => {
    const targets = readOnlyTargets(roster.getSnapshot())
    const next = targetsKey(targets)
    if (next === key) return
    key = next
    dispose?.()
    dispose = undefined
    if (targets.size === 0) return
    const entries = slots.entries(name).filter(entry => entry.component !== component)
    dispose = slots.register({ name, priority: freePriority(entries, { priority }), select: owner => targets.get(owner?.sessionId) ?? null }, component)
  }
  const unsubscribe = roster.subscribe(refresh)
  try { refresh() } catch (error) { unsubscribe(); throw error }
  return () => { unsubscribe(); dispose?.() }
}

// Takes the composer's place where the viewer may only read.
export function ReadOnlyComposer({ matched }) {
  const room = matched?.kind === 'room'
  return h('div', { className: 'bt-readonly', role: 'note' },
    h('span', { className: 'bt-readonly-title' }, room ? t('You can only view this group chat') : t('Readers can only view this agent')),
    h('span', { className: 'bt-readonly-hint' }, room ? t('Every agent in it must be shared with you as an editor to send messages.') : t('Ask its owner for editor access to send messages.')))
}

export const READ_ONLY_CSS = `
.bt-readonly{display:flex;flex-direction:column;gap:2px;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto 8px;box-sizing:border-box;min-height:44px;padding:10px 16px;border-radius:18px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-readonly-title{font-size:13px;line-height:18px;font-weight:500}
.bt-readonly-hint{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
`

// Every message the composer sends in the shown chat is claimed for the signed-in
// person, so the others see who wrote it. DSH lists a submission before it sends the
// prompt; `seen` outlives one binding, so a chat opened again claims nothing twice.
export function watchSubmissions(session, seen, claim) {
  if (typeof session?.subscribe !== 'function' || typeof session.getSnapshot !== 'function') return () => {}
  const check = () => {
    for (const item of session.getSnapshot()?.pendingSubmissions ?? []) {
      const id = item?.requestId
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      claim(id)
    }
  }
  const off = session.subscribe(check)
  check()
  return off
}

// -------------------------------------------------------------------------
// Who wrote a message, by the request id DSH keeps on it. Ids are asked in one
// batch per tick; an answer never changes, so a known id is never asked again. An id
// the host does not know yet (the writer's claim may land a moment after the message
// shows) is asked again a few times.
const AUTHOR_BATCH = 200
const AUTHOR_RETRIES = 3
const AUTHOR_RETRY_MS = 2000

export function authorCache({ schedule = fn => setTimeout(fn, 0), later = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() } = {}) {
  const entries = new Map()
  const listeners = new Set()
  let queued = false
  let fetcher
  const notify = () => { for (const listener of listeners) listener() }
  const flush = async () => {
    queued = false
    const ids = [...entries].filter(([, entry]) => entry.state === 'queued').map(([id]) => id)
    if (ids.length === 0 || fetcher === undefined) return
    for (const id of ids) entries.get(id).state = 'asking'
    let retry = false
    for (let at = 0; at < ids.length; at += AUTHOR_BATCH) {
      const batch = ids.slice(at, at + AUTHOR_BATCH)
      let found = {}
      try {
        found = (await fetcher(batch)) ?? {}
      } catch {
        found = {}
      }
      for (const id of batch) {
        const entry = entries.get(id)
        const author = found !== null && typeof found === 'object' && Object.hasOwn(found, id) ? found[id] : undefined
        if (author && typeof author.name === 'string') Object.assign(entry, { state: 'known', author: { id: author.id, name: author.name } })
        else {
          entry.tries += 1
          entry.state = entry.tries < AUTHOR_RETRIES ? 'missing' : 'unknown'
          entry.at = now()
          if (entry.state === 'missing') retry = true
        }
      }
    }
    notify()
    if (retry) later(() => { for (const id of ids) request(id) }, AUTHOR_RETRY_MS)
  }
  const request = (id, fetch) => {
    if (fetch !== undefined) fetcher = fetch
    if (typeof id !== 'string' || id === '') return
    const entry = entries.get(id)
    // Half the wait, so a retry timer that fires a little early still asks.
    if (entry !== undefined && (entry.state !== 'missing' || now() - entry.at < AUTHOR_RETRY_MS / 2)) return
    entries.set(id, { tries: entry?.tries ?? 0, state: 'queued', at: entry?.at ?? 0 })
    if (!queued) {
      queued = true
      schedule(() => { void flush() })
    }
  }
  return {
    request,
    get: id => (entries.get(id)?.state === 'known' ? entries.get(id).author : undefined),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

const authors = authorCache()

// The author of a message, once the host answered; undefined meanwhile and for a
// message nobody claimed. `rpcId` undefined asks nothing.
export function useAuthor(rpcId, fetchAuthors) {
  const [, setTick] = useState(0)
  const asked = typeof rpcId === 'string' && rpcId !== '' && typeof fetchAuthors === 'function'
  useEffect(() => {
    if (!asked) return undefined
    const off = authors.subscribe(() => setTick(tick => tick + 1))
    authors.request(rpcId, fetchAuthors)
    return off
  }, [asked, rpcId, fetchAuthors])
  return asked ? authors.get(rpcId) : undefined
}
