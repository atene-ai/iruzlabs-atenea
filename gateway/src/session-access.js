// What ds-bot says a staff member may do with each DSH Session: its `session-access`
// endpoint, asked as that person (their signed identity) through the gateway's own dsh
// session. Answers are kept for a short while per person and Session; a person whose
// grants change gets a fresh bucket, and a 401 or 403 for them empties theirs.
import http from 'node:http'
import { createHash } from 'node:crypto'

export const ACCESS_TTL_MS = 30_000
// ds-bot answers at most 500 Sessions per question.
const BATCH = 200
const REQUEST_TIMEOUT_MS = 10_000
const MAX_ENTRIES_PER_PERSON = 5_000
const LEVELS = new Set(['write', 'read', 'none'])

export class AccessCheckFailed extends Error {}

// The person and the grants their identity carries: a new SLA answer is a new bucket.
export function accessPrint(access) {
  const agents = Object.entries(access.agents ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify([access.id, access.role, agents])).digest('base64url').slice(0, 22)
}

function post(link, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: link.hostname, port: link.port, method: 'POST', path: '/api/bot', headers, agent: false, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('ds-bot did not answer in time')))
    request.on('error', reject)
    request.end(body)
  })
}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// `headersFor(session, cookie)` gives the headers of a request made as that person.
export function createSessionAccess({ link, headersFor, now = Date.now }) {
  /** @type {Map<string, Map<string, {allowed:string, until:number}>>} */
  const buckets = new Map()
  /** @type {Map<string, Promise<string>>} */
  const pending = new Map()

  async function ask(session, ids) {
    const body = JSON.stringify({ endpoint: 'session-access', payload: { sessionIds: ids } })
    for (let attempt = 0; ; attempt += 1) {
      const cookie = await link.cookie()
      const headers = { ...headersFor(session, cookie), 'content-type': 'application/json', accept: 'application/json', 'content-length': String(Buffer.byteLength(body)) }
      let answer
      try {
        answer = await post(link, headers, body)
      } catch (error) {
        throw new AccessCheckFailed(`ds-bot is unreachable: ${error?.message ?? error}`)
      }
      const json = parse(answer.text)
      // dsh's own 401 (a stale owner cookie) has no ds-bot answer in it.
      if (answer.status === 401 && json?.ok !== false) {
        link.invalidate(cookie)
        if (attempt === 0) continue
      }
      if (answer.status === 401 || answer.status === 403) {
        buckets.delete(accessPrint(session.access))
        throw new AccessCheckFailed(`ds-bot refused the identity (HTTP ${answer.status})`)
      }
      if (answer.status !== 200 || json?.ok !== true) throw new AccessCheckFailed(`ds-bot did not answer: ${json?.error?.code ?? `HTTP ${answer.status}`}`)
      return json.value?.sessions ?? {}
    }
  }

  function bucketOf(print) {
    let bucket = buckets.get(print)
    if (bucket === undefined) buckets.set(print, bucket = new Map())
    return bucket
  }

  function remember(bucket, id, allowed) {
    bucket.delete(id)
    bucket.set(id, { allowed, until: now() + ACCESS_TTL_MS })
    if (bucket.size > MAX_ENTRIES_PER_PERSON) bucket.delete(bucket.keys().next().value)
  }

  return {
    // Map of Session id → 'write' | 'read' | 'none' for this person. Throws
    // AccessCheckFailed when ds-bot cannot say; the caller refuses then.
    async levels(session, ids) {
      const print = accessPrint(session.access)
      const bucket = bucketOf(print)
      const result = new Map()
      // A Session another request is already asking about waits for that answer.
      const waits = new Map()
      const missing = []
      for (const id of new Set(ids)) {
        const kept = bucket.get(id)
        const asking = pending.get(`${print}\n${id}`)
        if (kept !== undefined && kept.until > now()) result.set(id, kept.allowed)
        else if (asking !== undefined) waits.set(id, asking)
        else missing.push(id)
      }
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH)
        const asked = ask(session, batch)
        for (const id of batch) {
          const key = `${print}\n${id}`
          const one = asked.then((sessions) => {
            const allowed = LEVELS.has(sessions[id]?.allowed) ? sessions[id].allowed : 'none'
            remember(bucketOf(print), id, allowed)
            return allowed
          }).finally(() => pending.delete(key))
          one.catch(() => {})
          pending.set(key, one)
          waits.set(id, one)
        }
      }
      for (const [id, one] of waits) result.set(id, await one)
      return result
    },

    invalidate(session) {
      buckets.delete(accessPrint(session.access))
    },

    sweep() {
      const at = now()
      for (const [print, bucket] of buckets) {
        for (const [id, entry] of bucket) if (entry.until <= at) bucket.delete(id)
        if (bucket.size === 0) buckets.delete(print)
      }
    },

    get size() {
      let size = 0
      for (const bucket of buckets.values()) size += bucket.size
      return size
    },
  }
}
