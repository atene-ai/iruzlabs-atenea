// Holds dsh's own Session calls to what each staff member may do with that Session
// (session-rules.js for which calls, session-access.js for ds-bot's answer). Unary calls
// are read before they are forwarded; Remote streams are checked when the browser opens
// them on /api/remote.mux, and a refused one is opened under an endpoint dsh does not
// know, so dsh fails that stream alone and the socket stays up. Superadmins pass.
import { ALLOWED_NAMESPACES } from './policy.js'
import { readBody } from './proxy.js'
import { AccessCheckFailed } from './session-access.js'
import { ROUTE_RULES, RULES, RuleError, sessionReferences, sessionsOf } from './session-rules.js'
import { OPCODE } from './websocket.js'

// Bodies the gateway reads before forwarding: dsh's JSON calls and ds-bot's channel. A
// base64 file upload is the largest of them.
export const GUARD_BODY_LIMIT = 16 * 1024 * 1024
export const DENIED_STREAM_ENDPOINT = 'atenea/forbidden'
const STREAM_NAMESPACES = new Set([...ALLOWED_NAMESPACES, '$events', 'remoteAccess'])
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const MESSAGES = {
  write: 'Readers can only view this conversation',
  none: 'Unknown conversation',
  superadmin: 'Only a superadmin can do this',
  rule: 'This action is not available on a shared Atenea server',
  reference: 'A message can only mention conversations you can read',
}

const superadmin = session => session.access.role === 'superadmin'
// dsh and ds-bot decode bodies as WHATWG UTF-8, which drops a leading byte order mark.
const decoder = new TextDecoder('utf-8')
const parseJson = (buffer) => {
  try {
    return { value: JSON.parse(decoder.decode(buffer)) }
  } catch {
    return undefined
  }
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function remoteEndpoint(pathname) {
  if (!pathname.startsWith('/api/')) return undefined
  const segments = pathname.slice('/api/'.length).split('/')
  return segments.length === 2 && segments.every(segment => SEGMENT.test(segment)) ? segments.join('/') : undefined
}

// dsh's answer to a refused unary call, in its own envelope, so the UI shows a refusal
// for that call instead of a transport failure.
function rpcRefusal(rpcId, endpoint, why) {
  return {
    status: 200,
    body: { type: 'server-response', rpcId, result: { ok: false, error: { code: 'atenea/forbidden', message: MESSAGES[why], details: { endpoint } } } },
  }
}
const plainRefusal = (status, error, reason) => ({ status, body: { error, reason } })
const botRefusal = why => ({ status: 403, body: { ok: false, error: { code: 'bot/forbidden', message: MESSAGES[why], details: {} } } })

export function createSessionGuard({ access, log = () => {} }) {
  // Why the person may not do `needs` ([{ id, need }]), or undefined when they may.
  async function shortfall(session, needs) {
    if (needs.length === 0) return undefined
    const levels = await access.levels(session, needs.map(entry => entry.id))
    for (const { id, need } of needs) {
      const level = levels.get(id) ?? 'none'
      if (level === 'none') return 'none'
      if (need === 'write' && level !== 'write') return 'write'
    }
    return undefined
  }

  // The rule's own Sessions and every Session a text in the payload mentions.
  function needsOf(rule, args, payload) {
    const needs = rule.need === 'read' || rule.need === 'write' ? sessionsOf(rule, args).map(id => ({ id, need: rule.need })) : []
    const references = sessionReferences(payload)
    if (references.unreadable) return { refused: 'reference' }
    return { needs: [...needs, ...references.ids.map(id => ({ id, need: 'read' }))], references: references.ids.length > 0 }
  }

  // Cuts a list answer down to the Sessions the person may read.
  const listFilter = (session, rule) => async (buffer) => {
    const envelope = parseJson(buffer)?.value
    if (!plainObject(envelope) || envelope.type !== 'server-response' || !plainObject(envelope.result)) throw new Error('unexpected list answer')
    if (envelope.result.ok !== true) return buffer
    const rows = rule.items(envelope.result.value)
    if (!Array.isArray(rows)) throw new Error('unexpected list answer')
    const ids = rows.map(row => row?.sessionId).filter(id => typeof id === 'string' && id !== '')
    const levels = ids.length === 0 ? new Map() : await access.levels(session, ids)
    const kept = rows.filter(row => ['read', 'write'].includes(levels.get(row?.sessionId)))
    if (kept.length === rows.length) return buffer
    rows.splice(0, rows.length, ...kept)
    return Buffer.from(JSON.stringify(envelope))
  }

  // DSH answering 401 or 403 to a checked call may mean what ds-bot said is stale.
  const onStatus = session => (status) => {
    if (status === 401 || status === 403) access.invalidate(session)
  }

  const refuseLogged = (session, what, why, refusal) => {
    log(`gateway: staff ${session.access.id} refused ${what}: ${why}`)
    return { refuse: refusal }
  }

  async function remote(req, session, endpoint) {
    const rule = Object.hasOwn(RULES, endpoint) && RULES[endpoint].stream !== true ? RULES[endpoint] : undefined
    const body = await readBody(req, GUARD_BODY_LIMIT)
    const envelope = parseJson(body)?.value
    const valid = plainObject(envelope) && envelope.type === 'client-request' && typeof envelope.rpcId === 'string' && envelope.method === endpoint
      && plainObject(envelope.payload) && plainObject(envelope.payload.args)
    if (!valid) return { refuse: plainRefusal(400, 'atenea/bad-request', 'not a dsh call for this path') }
    if (rule === undefined) return refuseLogged(session, endpoint, 'no rule', rpcRefusal(envelope.rpcId, endpoint, 'rule'))
    if (rule.need === 'superadmin') return refuseLogged(session, endpoint, 'superadmin only', rpcRefusal(envelope.rpcId, endpoint, 'superadmin'))
    let wanted
    try {
      wanted = needsOf(rule, envelope.payload.args, envelope.payload)
    } catch (error) {
      if (!(error instanceof RuleError)) throw error
      return { refuse: plainRefusal(400, 'atenea/bad-request', error.message) }
    }
    if (wanted.refused) return refuseLogged(session, endpoint, 'unreadable session reference', rpcRefusal(envelope.rpcId, endpoint, wanted.refused))
    const why = await shortfall(session, wanted.needs)
    if (why !== undefined) {
      const reason = wanted.references && why === 'none' ? 'reference' : why
      return refuseLogged(session, endpoint, `session ${why}`, rpcRefusal(envelope.rpcId, endpoint, reason))
    }
    return {
      body,
      onStatus: onStatus(session),
      ...(rule.items ? { transform: listFilter(session, rule) } : {}),
    }
  }

  async function route(req, url, session, rule) {
    const values = url.searchParams.getAll(rule.query)
    // dsh reads the first value in one route and the last in another; one is unambiguous.
    if (values.length !== 1 || values[0] === '') return { refuse: plainRefusal(400, 'atenea/bad-request', `one ${rule.query} is required`) }
    const why = await shortfall(session, [{ id: values[0], need: rule.need }])
    if (why !== undefined) return refuseLogged(session, url.pathname, `session ${why}`, plainRefusal(why === 'none' ? 404 : 403, 'atenea/forbidden', MESSAGES[why]))
    return { onStatus: onStatus(session) }
  }

  // ds-bot checks its own channel; what dsh would make of a mention in it is checked here.
  async function botChannel(req, session) {
    const body = await readBody(req, GUARD_BODY_LIMIT)
    const parsed = parseJson(body)
    if (parsed === undefined) return { body }
    const references = sessionReferences(parsed.value)
    if (references.unreadable) return refuseLogged(session, 'api/bot', 'unreadable session reference', botRefusal('reference'))
    const why = await shortfall(session, references.ids.map(id => ({ id, need: 'read' })))
    if (why !== undefined) return refuseLogged(session, 'api/bot', `mentioned session ${why}`, botRefusal('reference'))
    return { body }
  }

  async function guarded(run) {
    try {
      return await run()
    } catch (error) {
      if (error instanceof AccessCheckFailed) {
        log(`gateway: session check failed: ${error.message}`)
        return { refuse: plainRefusal(503, 'atenea/unavailable', 'access could not be checked') }
      }
      if (error?.code === 'BODY_TOO_LARGE') return { refuse: plainRefusal(413, 'atenea/too-large', 'request body too large') }
      throw error
    }
  }

  return {
    // For one allowed HTTP request: { refuse: { status, body } }, or what the forward
    // needs: the body already read, a filter for a list answer, a status hook.
    request(req, url, session) {
      if (superadmin(session)) return {}
      if (Object.hasOwn(ROUTE_RULES, url.pathname) && ROUTE_RULES[url.pathname].methods.includes(req.method)) {
        return guarded(() => route(req, url, session, ROUTE_RULES[url.pathname]))
      }
      if (req.method !== 'POST') return {}
      if (url.pathname === '/api/bot') return guarded(() => botChannel(req, session))
      const endpoint = remoteEndpoint(url.pathname)
      return endpoint === undefined ? {} : guarded(() => remote(req, session, endpoint))
    },

    // For one whole message the browser sent on the Remote stream socket: the payload to
    // send on, or null to close the socket. Only `open` messages are decided.
    async streamMessage(session, { opcode, data }) {
      // dsh's mux takes text only and closes the socket on anything else.
      if (opcode !== OPCODE.text) return null
      const parsed = parseJson(data)
      if (parsed === undefined) return null
      const message = parsed.value
      if (!plainObject(message) || message.type !== 'open') return data
      if (typeof message.streamId !== 'string' || typeof message.endpoint !== 'string') return null
      const deny = (why) => {
        log(`gateway: staff ${session.access.id} refused stream ${message.endpoint}: ${why}`)
        return Buffer.from(JSON.stringify({ type: 'open', streamId: message.streamId, endpoint: DENIED_STREAM_ENDPOINT, payload: { args: {} } }))
      }
      const rule = Object.hasOwn(RULES, message.endpoint) && RULES[message.endpoint].stream === true ? RULES[message.endpoint] : undefined
      if (!STREAM_NAMESPACES.has(message.endpoint.split('/')[0])) return deny('blocked endpoint')
      if (superadmin(session)) return data
      if (rule === undefined) return deny('no rule')
      const args = plainObject(message.payload) && plainObject(message.payload.args) ? message.payload.args : {}
      try {
        const wanted = needsOf(rule, args, message.payload)
        if (wanted.refused) return deny('unreadable session reference')
        const why = await shortfall(session, wanted.needs)
        return why === undefined ? data : deny(`session ${why}`)
      } catch (error) {
        if (error instanceof RuleError) return deny(error.message)
        if (error instanceof AccessCheckFailed) return deny(error.message)
        throw error
      }
    },
  }
}
