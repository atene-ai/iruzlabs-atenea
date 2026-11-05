// Which DSH Remote calls act on a Session, where their arguments name it, and what each
// needs from the caller. dsh admits every browser as its one owner, so the gateway asks
// ds-bot what a staff member may do with each Session (session-access.js) and holds the
// call to it here. Superadmins are not checked; the path policy (policy.js) still applies
// to everyone first.
//
// Every method of every namespace the path policy lets through has a rule, and so does
// every Remote stream the Atenea UI opens on the mux; a method without one is refused to
// everyone but superadmins. Rules follow dsh 0.2.0-rc.2 and 0.2.1-rc.5:
// test/fixtures/dsh-remotes.json lists their endpoints (scripts/dsh-remotes.mjs), and a
// test fails when an allowed namespace gains a method without a rule here.
//
// A rule's `need`:
// - open: names no Session; anyone the gateway admits.
// - read / write: every Session at `paths` (wire argument names, then fields) must be
//   readable / writable by the caller. A path ending in `address` holds a dsh
//   SessionAddress: an ordinary Session or a subagent with its parent, both checked.
// - superadmin: makes or rearranges Sessions and Workspaces outside any Bot (ds-bot owns
//   where Bot Sessions live), or acts on the host itself.
// `items(value)` names the result rows a list answer is cut down to, keeping only the
// Sessions the caller may read. `stream` marks a Remote stream, opened on /api/remote.mux.

const open = Object.freeze({ need: 'open' })
const superadmin = Object.freeze({ need: 'superadmin' })
const read = (...paths) => ({ need: 'read', paths })
const write = (...paths) => ({ need: 'write', paths })
const stream = rule => ({ ...rule, stream: true })
const rowsOf = value => value?.items
const rowList = value => value

export const RULES = Object.freeze({
  'agentPresets/list': open,
  'agentPresets/read': open,
  // Also refused by the path policy: it changes the profile's default preset.
  'agentPresets/select': write('agentId'),
  'commands/execute': write('agentId'),
  'commands/list': read('agentId'),
  'credentials/describe': open,
  'credentials/set': superadmin,
  'credentials/unset': superadmin,
  'fileReferences/list': read('agentId'),
  'fileUploads/upload': write('agentId'),
  'goals/clear': write('agentId'),
  'goals/complete': write('agentId'),
  'goals/create': write('agentId'),
  'goals/edit': write('agentId'),
  'goals/get': read('agentId'),
  'goals/pause': write('agentId'),
  'goals/resume': write('agentId'),
  'job/follow': stream(read('request.sessionId')),
  'job/kill': write('request.sessionId'),
  'job/list': stream(read('request.sessionId')),
  // Fetches a provider's model list from any URL with any key: a settings-page action.
  'llm/discoverModels': superadmin,
  'llm/listConfigurableProviders': open,
  'llm/listProviders': open,
  'messageFeedback/delete': write('request.sessionId'),
  'messageFeedback/list': read('request.sessionId'),
  'messageFeedback/put': write('request.sessionId'),
  'permissionPresets/catalog': open,
  'pluginInventory/list': open,
  'session/attachment': read('request.sessionId'),
  'session/canOpenWorkspacePath': open,
  'session/cancel': write('request.sessionId'),
  // Host-wide projections of every Session; see "What stays possible" in the README.
  'session/control': stream(open),
  // A new Session, or adopting a named one, belongs to no Bot.
  'session/create': superadmin,
  'session/follow': stream(read('request.address')),
  // The copy is a Session of DSH's own, which only superadmins reach.
  'session/fork': superadmin,
  'session/initializeDefaultModel': open,
  'session/list': { ...open, items: rowsOf },
  'session/modelCatalog': open,
  'session/openWorkspacePath': superadmin,
  'session/page': read('request.address'),
  'session/projections': read('request.sessionId'),
  'session/prompt': write('request.sessionId'),
  'session/rename': write('request.sessionId'),
  'session/search': { ...open, items: rowsOf },
  'session/selectModel': write('request.sessionId'),
  'session/updateQueue': write('request.sessionId'),
  'session/workspacePathApplications': superadmin,
  'sessionFeedback/record': write('request.sessionId'),
  'sessionReferenceResolver/candidates': { ...read('agentId'), items: rowList },
  'settings/describe': open,
  'settings/mutate': superadmin,
  'settings/openSettingsDocument': superadmin,
  'settings/replace': superadmin,
  'settings/update': superadmin,
  'skills/list': read('request.sessionId'),
  'subagents/interruptByParent': write('childSessionId', 'parentSessionId'),
  'subagents/prompt': write('request.parentSessionId', 'request.childSessionId'),
  'userQuestions/answer': write('agentId'),
  'userQuestions/attachWait': stream(read('agentId')),
  'workspace/archiveSession': superadmin,
  'workspace/create': superadmin,
  'workspace/delete': superadmin,
  // Every Workspace and its Session order; see "What stays possible" in the README.
  'workspace/follow': stream(open),
  'workspace/initializeDefault': open,
  'workspace/insertBefore': superadmin,
  'workspace/insertSessionBefore': superadmin,
  'workspace/pinSession': write('request.sessionId'),
  'workspace/rename': superadmin,
  'workspace/unarchiveSession': superadmin,
  'workspace/unpinSession': write('request.sessionId'),
  // Host events for every Session; see "What stays possible" in the README.
  $events: stream(open),
  // dsh 0.2.1: the access snapshot, which for the owner says only that it is the owner.
  'remoteAccess/follow': stream(open),
})

// Exact dsh routes outside the Remote protocol that name a Session in the query.
export const ROUTE_RULES = Object.freeze({
  '/api/session.export': { methods: ['GET', 'HEAD'], need: 'read', query: 'sessionId' },
  '/api/session/uploadFileBinary': { methods: ['POST'], need: 'write', query: 'sessionId' },
})

export class RuleError extends Error {}

const own = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
const isId = value => typeof value === 'string' && value !== ''

function at(args, path) {
  let value = args
  for (const key of path.split('.')) {
    if (!own(value, key)) throw new RuleError(`no ${path}`)
    value = value[key]
  }
  return value
}

function addressIds(address, path) {
  if (own(address, 'kind') && address.kind === 'session' && isId(address.sessionId)) return [address.sessionId]
  if (own(address, 'kind') && address.kind === 'subagent' && isId(address.parentSessionId) && isId(address.childSessionId)) {
    return [address.parentSessionId, address.childSessionId]
  }
  throw new RuleError(`${path} is not a Session address`)
}

// The Sessions a call's arguments name for its rule; throws RuleError when one is
// missing or malformed, as dsh would refuse that call anyway.
export function sessionsOf(rule, args) {
  const ids = []
  for (const path of rule.paths ?? []) {
    const value = at(args, path)
    if (path === 'address' || path.endsWith('.address')) ids.push(...addressIds(value, path))
    else if (isId(value)) ids.push(value)
    else throw new RuleError(`${path} is not a Session id`)
  }
  return ids
}

// dsh-session-reference turns `dsh-session:<base64url JSON string>` in a person's message
// into a snapshot of that other Session for the model, so naming a Session in any text
// is reading it. Every string of the payload is searched, keys too; a reference that
// does not decode makes the whole call unreadable, rather than guess what dsh makes of it.
const SCHEME = 'dsh-session:'
const PAYLOAD = /^[A-Za-z0-9_-]*/
const MAX_DEPTH = 64

function decodeReference(payload) {
  if (payload === '') return undefined
  try {
    const id = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return isId(id) && Buffer.from(JSON.stringify(id), 'utf8').toString('base64url') === payload ? id : undefined
  } catch {
    return undefined
  }
}

export function sessionReferences(value) {
  const ids = new Set()
  let unreadable = false
  const scan = (text) => {
    for (let at = text.indexOf(SCHEME); at !== -1; at = text.indexOf(SCHEME, at + SCHEME.length)) {
      const id = decodeReference(PAYLOAD.exec(text.slice(at + SCHEME.length))[0])
      if (id === undefined) unreadable = true
      else ids.add(id)
    }
  }
  const walk = (node, depth) => {
    if (typeof node === 'string') return scan(node)
    if (node === null || typeof node !== 'object') return
    if (depth > MAX_DEPTH) {
      unreadable = true
      return
    }
    for (const [key, child] of Object.entries(node)) {
      scan(key)
      walk(child, depth + 1)
    }
  }
  walk(value, 0)
  return { ids: [...ids], unreadable }
}
