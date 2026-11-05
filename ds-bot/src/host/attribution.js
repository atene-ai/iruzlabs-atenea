// Attribution: on a shared server several people write in the same Bot chats and group
// chats, so each message they send keeps who wrote it. DSH records a composer message
// with its prompt's request id as `source.rpcId`; the window that sent it claims that id
// for its signed-in person (the `author` endpoint), and the host's own sends claim theirs
// before prompting. The names live beside the team, not in state.json, so the team file
// does not grow with every message.
import { mkdirSync, readFileSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'

const AUTHORS_MAX = 20_000
const SAVE_DELAY_MS = 1000
const REQUEST_ID = /^[\w-]{8,100}$/

export const authorLabel = name => `[From ${name}]`

// A person's message as a Bot reads it: their name first, so a shared chat says who
// asked. Messages without a known author are left as they are.
export function withAuthors(messages, authorOf) {
  let changed = false
  const next = messages.map((message) => {
    if (message?.role !== 'user' || message.source?.kind !== 'user') return message
    const author = authorOf(message.source.rpcId)
    if (author === undefined) return message
    const label = authorLabel(author.name)
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
    const at = content.findIndex(block => block?.type === 'text')
    if (at !== -1 && content[at].text.startsWith(label)) return message
    changed = true
    return {
      ...message,
      content: at === -1
        ? [{ type: 'text', text: label }, ...content]
        : content.map((block, index) => (index === at ? { ...block, text: `${label}\n${block.text}` } : block)),
    }
  })
  return changed ? next : messages
}

export function install(rt) {
  const { ctx } = rt
  const path = join(rt.home, 'authors.json')
  /** @type {Map<string, {id:string, name:string, at:number}>} oldest first */
  let authors
  let timer
  let writing = Promise.resolve()

  const loaded = () => {
    if (authors !== undefined) return authors
    authors = new Map()
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      for (const [requestId, entry] of Object.entries(saved ?? {})) {
        if (REQUEST_ID.test(requestId) && typeof entry?.id === 'string' && typeof entry?.name === 'string') authors.set(requestId, { id: entry.id, name: entry.name, at: Number(entry.at) || 0 })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn?.('ds-bot: authors file %s not read: %s', path, error)
    }
    return authors
  }

  const persist = () => {
    const snapshot = JSON.stringify(Object.fromEntries(loaded()))
    const temp = `${path}.${process.pid}.tmp`
    writing = writing.then(async () => {
      try {
        mkdirSync(rt.home, { recursive: true })
        await writeFile(temp, snapshot, 'utf8')
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        rt.warn?.('ds-bot: authors file %s not written: %s', path, error)
      }
    })
    return writing
  }
  const schedule = () => {
    if (timer !== undefined || rt.readOnly?.() !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void persist()
    }, SAVE_DELAY_MS)
    timer.unref?.()
  }

  // The first claim wins: a later one for the same id, from any window, changes nothing.
  function noteAuthor(requestId, identity) {
    if (!rt.multiuser || identity === undefined || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return false
    const list = loaded()
    if (list.has(requestId)) return list.get(requestId).id === identity.id
    list.set(requestId, { id: identity.id, name: identity.name, at: Date.now() })
    while (list.size > AUTHORS_MAX) list.delete(list.keys().next().value)
    schedule()
    return true
  }

  const authorOf = (requestId) => {
    if (!rt.multiuser || typeof requestId !== 'string') return undefined
    const entry = loaded().get(requestId)
    return entry === undefined ? undefined : { id: entry.id, name: entry.name }
  }

  // The person who wrote a user message the host reads from a Session, as fields for
  // a group log line or a queued room message.
  const authorFields = (source) => {
    const author = authorOf(source?.rpcId)
    return author === undefined ? {} : { author: author.name, authorId: author.id }
  }

  // The name only changes what the model reads; the Session keeps what the person typed.
  const rewritten = new WeakSet()
  ctx.on('llm/stream', (options, next) => {
    if (!rt.multiuser || options.sessionId === undefined || options.purpose !== undefined || !Array.isArray(options.messages) || rewritten.has(options.messages)) return next()
    // A group chat's own Session never reaches the model (groups.js); its members read
    // the names from the group's log instead.
    if (rt.roomOf(options.sessionId) !== undefined) return next()
    const messages = withAuthors(options.messages, authorOf)
    if (messages === options.messages) return next()
    rewritten.add(messages)
    rt.carryUsageTag?.(options.messages, messages)
    return ctx.llm.stream({ ...options, messages })
  })

  ctx.effect?.(() => () => {
    if (timer === undefined) return writing
    clearTimeout(timer)
    timer = undefined
    return persist()
  }, 'ds-bot: authors')

  Object.assign(rt, { noteAuthor, authorOf, authorFields })
}
