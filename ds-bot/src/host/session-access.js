// Session access: what the person asking may do with DSH Sessions on a shared server.
// The gateway in front of DSH Web asks before it forwards a DSH call that names a
// Session (`session-access`), because DSH admits every browser as its one owner and
// checks nothing per person. A Session answers for the Bot or group chat it belongs
// to: a Bot's own chat, its group Sessions and their earlier parts (access.js), and a
// subagent Session for the Session it was spawned from. Any other Session is DSH's
// own, and only superadmins reach it.

// One question names at most this many Sessions; the gateway asks in batches.
export const MAX_SESSION_IDS = 500
const MAX_ID_LENGTH = 200
// Subagents may spawn subagents; a chain longer than this is not followed.
const MAX_DEPTH = 32
// A Session no Bot owns makes the host list DSH's Sessions again, at most this often.
const RELIST_MS = 5_000
const LIST_TIMEOUT_MS = 10_000

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, string>} sessionId → parentSessionId, from DSH's Session list */
  let parents = new Map()
  let listedAt = -Infinity
  let listing

  // A live subagent knows its parent; a cold one is found in DSH's Session list.
  const liveParent = id => ctx.get?.('agents')?.get?.(id)?.session?.header?.parentSession

  function relist() {
    if (Date.now() - listedAt < RELIST_MS) return listing ?? Promise.resolve()
    listing ??= (async () => {
      try {
        const items = (await ctx.sessionController.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS))).items ?? []
        parents = new Map(items.filter(item => typeof item.parentSessionId === 'string').map(item => [item.sessionId, item.parentSessionId]))
      } catch (error) {
        rt.warn('ds-bot: session access could not list the Sessions: %s', error?.message ?? error)
      } finally {
        listedAt = Date.now()
        listing = undefined
      }
    })()
    return listing
  }

  // The Session whose Bot or group answers for `id`: itself, or the nearest ancestor a
  // Bot owns. Undefined for a Session of DSH's own.
  async function ownedRoot(id) {
    let current = id
    let listed = false
    for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
      if (rt.access.sessionTarget(current) !== undefined) return current
      let parent = liveParent(current) ?? parents.get(current)
      if (parent === undefined && !listed) {
        listed = true
        await relist()
        parent = parents.get(current)
      }
      if (typeof parent !== 'string' || parent === '' || parent === current) return undefined
      current = parent
    }
    return undefined
  }

  async function answerFor(id) {
    const root = await ownedRoot(id)
    const target = root === undefined ? undefined : rt.access.sessionTarget(root)
    const probe = { sessionId: root ?? id }
    const allowed = rt.access.writes(probe) ? 'write' : rt.access.sees(probe) ? 'read' : 'none'
    if (allowed === 'none' || target === undefined) return { allowed }
    const botId = rt.selfOf(root) ?? target.botId
    return { allowed, ...(botId !== undefined ? { botId } : {}), ...(target.roomId !== undefined ? { roomId: target.roomId } : {}) }
  }

  // Answers only about the person asking: their own access, never anyone else's.
  async function sessionAccess(sessionIds) {
    if (!rt.multiuser) throw Object.assign(new Error('Session access is only answered on a shared Atenea server'), { code: 'bot/unavailable' })
    if (!Array.isArray(sessionIds)) throw invalid('sessionIds must be a list')
    const ids = [...new Set(sessionIds)]
    if (ids.length > MAX_SESSION_IDS) throw invalid(`Ask about at most ${MAX_SESSION_IDS} Sessions at a time`)
    if (!ids.every(id => typeof id === 'string' && id !== '' && id.length <= MAX_ID_LENGTH)) throw invalid('Every Session id must be a short string')
    await rt.load()
    const sessions = {}
    for (const id of ids) sessions[id] = await answerFor(id)
    return { sessions }
  }

  Object.assign(rt, { sessionAccess })
}
