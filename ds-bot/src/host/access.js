// Access: what each staff member may see and do when several share one Atenea server.
// A person sees a Bot that SLA shares with them (the `agents` claim of their identity,
// identity.js) and every Bot when they are a superadmin. Owners and editors chat with
// and change a Bot; readers only read; only an owner deletes it or changes who it is
// shared with; team-wide settings and Main Bots are for superadmins. A group chat is
// shown when every member is, and takes part in as far as every member allows.
// Everything here is inert unless ATENEA_MULTIUSER=1.
import { createHash } from 'node:crypto'

const RANK = { reader: 1, editor: 2, owner: 3 }
const SUPER = 4
const SHARE_ROLES = ['editor', 'reader']
// SLA is the source of truth, but the gateway may serve an older `agents` claim for a
// while after a change this host made; the change counts here until then.
const OVERLAY_MS = 5 * 60_000

const refusal = (code, message) => Object.freeze({ code, message })
export const REFUSALS = Object.freeze({
  notFound: refusal('bot/not-found', 'Unknown agent'),
  reader: refusal('bot/forbidden', 'Readers can only view this agent'),
  roomReader: refusal('bot/forbidden', 'Readers can only view this group chat'),
  owner: refusal('bot/forbidden', 'Only the owner of this agent can do this'),
  admin: refusal('bot/forbidden', 'Only a superadmin can do this'),
  main: refusal('bot/forbidden', 'Only a superadmin can work with a Main Bot'),
  off: refusal('bot/forbidden', 'Sign-in is handled by the Atenea server'),
  noRule: refusal('bot/forbidden', 'This action is not available on a shared Atenea server'),
})

const str = value => (typeof value === 'string' ? value : '')
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const bot = key => body => ({ botId: str(body[key]) })
const room = key => body => ({ roomId: str(body[key]) })
const session = key => body => ({ sessionId: str(body[key]) })
const memoryPanel = body => (body.roomId !== undefined ? { roomId: str(body.roomId) } : { botId: str(body.botId) })
const ids = list => (Array.isArray(list) ? list.filter(id => typeof id === 'string') : [])

// How every /api/bot endpoint is gated on a shared server. `kind`:
// - any: every signed-in staff member (a few check a field with `check`);
// - read: the viewer must see the target; write: owner or editor of it; manage: its owner;
// - create: any staff member, and the new Bot is registered to them in SLA;
// - admin: superadmins only (team-wide settings, Main Bot powers, the host itself);
// - off: not offered on a shared server.
// `target(body, rt)` names what the call acts on: { botId } | { roomId } | { sessionId },
// or a list of them. A call with no rule here is refused, so a new endpoint must add one.
// `audit` (default: write, manage and create) sends the action to SLA's audit log.
export const ENDPOINT_RULES = {
  state: { kind: 'any' },
  models: { kind: 'any' },
  efforts: { kind: 'any' },
  thinking: { kind: 'read', target: session('sessionId') },
  providers: { kind: 'admin' },
  'provider-key': { kind: 'admin', audit: true },
  'provider-add': { kind: 'admin', audit: true },
  'provider-models': { kind: 'admin' },
  'provider-remove': { kind: 'admin', audit: true },
  'duplicate-bot': { kind: 'write', target: bot('id') },
  // Display preferences are kept per person; the model new Bots start on is the team's.
  'set-prefs': { kind: 'any', check: (body, access) => (body.defaultBotModel !== undefined && !access.superadmin() ? REFUSALS.admin : undefined) },
  exchange: { kind: 'read', target: body => [{ botId: str(body.a) }, { botId: str(body.b) }] },
  'exchange-text': { kind: 'read', target: (body, rt) => exchangeTargets(rt, body.id) },
  'file-text': { kind: 'read', target: (body, rt) => fileTargets(rt, body.file) },
  earlier: { kind: 'read', target: session('sessionId') },
  chat: { kind: 'read', target: bot('botId') },
  'run-stats': { kind: 'read', target: bot('botId') },
  usage: { kind: 'admin' },
  'room-progress': { kind: 'read', target: room('roomId') },
  // A folder is a place on the server itself, which only a superadmin picks.
  'create-bot': { kind: 'create', check: (body, access) => (typeof body.workDir === 'string' && body.workDir !== '' && !access.superadmin() ? REFUSALS.admin : undefined) },
  // A Bot's folder and sandbox reach the server itself; private changes who reads it.
  'update-bot': {
    kind: 'write',
    target: bot('id'),
    check: (body, access) => {
      if (['workDir', 'permission', 'browserGrants'].some(key => body[key] !== undefined) && !access.superadmin()) return REFUSALS.admin
      if (body.private !== undefined && !access.manages({ botId: str(body.id) })) return REFUSALS.owner
      return undefined
    },
  },
  resume: { kind: 'write', target: bot('botId') },
  'avatar-library': { kind: 'any' },
  'avatar-import': { kind: 'any' },
  'avatar-delete': { kind: 'admin', audit: true },
  'delete-bot': { kind: 'manage', target: bot('id') },
  'private-release': { kind: 'admin', audit: true },
  'set-main': { kind: 'admin', audit: true },
  'create-room': { kind: 'write', target: body => [...ids(body.members), ...(typeof body.admin === 'string' ? [body.admin] : [])].map(botId => ({ botId })) },
  'update-room': { kind: 'write', target: body => [{ roomId: str(body.id) }, ...[...ids(body.members), ...ids(body.add), ...(typeof body.admin === 'string' ? [body.admin] : [])].map(botId => ({ botId }))] },
  folders: { kind: 'admin' },
  'folder-pick': { kind: 'admin' },
  'folder-list': { kind: 'admin' },
  'team-workspace': { kind: 'admin', audit: true },
  'add-agent': { kind: 'admin', audit: true },
  'agent-session': { kind: 'admin' },
  'agent-adopt': { kind: 'admin' },
  'agent-archive': { kind: 'admin', audit: true },
  'agent-rename': { kind: 'admin' },
  'remove-agent': { kind: 'admin', audit: true },
  // Pins and hidden marks are kept per person, so seeing the chat is enough.
  'set-flags': { kind: 'read', target: body => (typeof body.id === 'string' ? { sessionId: body.id } : { missing: true }), audit: false },
  'delete-room': { kind: 'manage', target: room('id') },
  'approval-answer': { kind: 'write', target: (body, rt) => ({ sessionId: str(rt.approvalsView?.().find(entry => entry.id === body.id)?.sessionId) }) },
  'stop-member-work': { kind: 'write', target: room('roomId') },
  'stop-room-work': { kind: 'write', target: room('roomId') },
  'goal-draft': { kind: 'write', target: room('roomId') },
  'goal-control': { kind: 'write', target: room('roomId') },
  'dismiss-question': { kind: 'write', target: session('sessionId') },
  'dismiss-view': { kind: 'write', target: session('sessionId') },
  // A key saved from a Bot's card is that Bot's business; the key list is the team's.
  'secret-set': { kind: body => (body.requestId === undefined ? 'admin' : 'write'), target: (body, rt) => secretRequestTarget(rt, body.requestId) },
  'secret-allow': { kind: 'write', target: (body, rt) => secretRequestTarget(rt, body.requestId) },
  'secret-cancel': { kind: 'write', target: (body, rt) => secretRequestTarget(rt, body.requestId) },
  'secret-update': { kind: 'admin', audit: true },
  'secret-delete': { kind: 'admin', audit: true },
  'connector-connect': { kind: 'admin', audit: true },
  'connector-disconnect': { kind: 'admin', audit: true },
  'connector-retry': { kind: 'admin' },
  'capability-save': { kind: 'admin', audit: true },
  'capability-delete': { kind: 'admin', audit: true },
  'capability-approve': { kind: 'admin', audit: true },
  'bot-capability': { kind: 'write', target: bot('botId') },
  schedules: { kind: 'any' },
  'schedule-create': { kind: 'write', target: body => ({ sessionId: str(body.target) }) },
  'schedule-delete': { kind: 'write', target: session('sessionId') },
  'memory-view': { kind: 'read', target: memoryPanel },
  'memory-history': { kind: 'read', target: memoryPanel },
  // Changes to the team memory inside an ask or a restore are refused in memory.js.
  'memory-ask': { kind: 'write', target: memoryPanel },
  'memory-forget': { kind: body => (body.scope === 'team' ? 'admin' : 'write'), target: memoryPanel },
  'memory-restore': { kind: 'write', target: memoryPanel },
  'learning-answer': { kind: 'write', target: (body, rt) => proposalTarget(rt, body.id) },
  'auth-view': { kind: 'any' },
  'auth-start': { kind: 'off' },
  'auth-cancel': { kind: 'off' },
  'auth-sign-out': { kind: 'off' },
  'auth-dev-login': { kind: 'off' },
  'answer-question': { kind: 'write', target: session('sessionId') },
  'view-reply': { kind: 'write', target: session('sessionId') },
  send: { kind: 'write', target: session('sessionId') },
  'btw-delete': { kind: 'write', target: session('sessionId') },
  'side-new': { kind: 'write', target: session('sessionId') },
  'side-ask': { kind: 'write', target: session('sessionId') },
  'side-cancel': { kind: 'write', target: (body, rt) => sideChatTarget(rt, body.chatId) },
  'side-close': { kind: 'write', target: (body, rt) => sideChatTarget(rt, body.chatId) },
  'update-check': { kind: 'any' },
  'update-install': { kind: 'admin', audit: true },
  'dsh-update-install': { kind: 'admin', audit: true },
  'repo-stars': { kind: 'any' },
  // The Desktop window serves every Bot's browser reads; a shared server has none.
  'browser-wait': { kind: 'admin' },
  'browser-result': { kind: 'admin' },
  'browser-takeover': { kind: 'write', target: bot('botId') },
  'browser-give-back': { kind: 'write', target: bot('botId') },
  'browser-stop': { kind: 'write', target: bot('botId') },
  diagnostics: { kind: 'admin' },
  'diagnostics-log': { kind: 'admin' },
  'diagnostics-clear': { kind: 'admin', audit: true },
  shares: { kind: 'manage', target: bot('botId'), audit: false },
  'share-add': { kind: 'manage', target: bot('botId') },
  'share-remove': { kind: 'manage', target: bot('botId') },
  'staff-search': { kind: 'any' },
  'claim-bot': { kind: 'admin', target: bot('id'), audit: true },
  author: { kind: 'write', target: session('sessionId'), audit: false },
  authors: { kind: 'any' },
  // Each person's own CRM link and accounts (crm.js). Linking completes on the callback
  // route, which writes its own audit line.
  'crm-view': { kind: 'any' },
  'crm-link-start': { kind: 'any' },
  'crm-unlink': { kind: 'any', audit: true },
  'crm-unattended': { kind: 'manage', target: bot('botId') },
}

function exchangeTargets(rt, id) {
  const entry = rt.state.exchanges.find(item => item.id === id)
  if (entry === undefined) return { missing: true }
  return [entry.from, entry.to].filter(value => typeof value === 'string').map(botId => ({ botId }))
}

// A stored file is shown where it was posted: a group chat's log or a message between
// Bots. A file that is neither is only for superadmins.
function fileTargets(rt, file) {
  const id = file?.attachmentId
  if (typeof id !== 'string') return { missing: true }
  const has = files => (files ?? []).some(item => item?.attachmentId === id)
  const rooms = Object.values(rt.state.rooms).filter(entry => (entry.log ?? []).some(line => has(line.files)))
  const exchanges = rt.state.exchanges.filter(entry => has(entry.files))
  const targets = [...rooms.map(entry => ({ roomId: entry.id })), ...exchanges.flatMap(entry => [entry.from, entry.to].filter(Boolean).map(botId => ({ botId })))]
  return targets.length === 0 ? { missing: true } : { anyOf: targets }
}

function secretRequestTarget(rt, requestId) {
  for (const [botId, list] of Object.entries(rt.state.secretRequests ?? {})) {
    if ((list ?? []).some(request => request?.id === requestId)) return { botId }
  }
  return { missing: true }
}

function proposalTarget(rt, id) {
  for (const [botId, list] of Object.entries(rt.learningView?.() ?? {})) {
    if ((list ?? []).some(entry => entry?.id === id)) return { botId }
  }
  return { missing: true }
}

function sideChatTarget(rt, chatId) {
  for (const [botId, list] of Object.entries(rt.sideView?.() ?? {})) {
    if ((list ?? []).some(chat => chat?.id === chatId)) return { botId }
  }
  return { missing: true }
}

const ruleKind = (rule, body) => (typeof rule.kind === 'function' ? rule.kind(body) : rule.kind)
const audited = (rule, kind) => rule.audit ?? (kind === 'write' || kind === 'manage' || kind === 'create')

export function install(rt) {
  const { state } = rt
  /** @type {Map<string, {role:string|null, until:number}>} keyed `${staffId}\n${botId}` */
  const overlays = new Map()
  let overlayVersion = 0

  const viewer = () => rt.viewer?.()
  const superadmin = () => viewer()?.role === 'superadmin'
  const shared = () => (state.multiuser ??= {})
  const table = name => (shared()[name] ??= {})

  const overlay = (staffId, botId, role) => {
    overlays.set(`${staffId}\n${botId}`, { role, until: Date.now() + OVERLAY_MS })
    overlayVersion += 1
  }
  const grantOf = (person, botId) => {
    const kept = overlays.get(`${person.id}\n${botId}`)
    if (kept !== undefined && kept.until > Date.now()) return kept.role
    return Object.hasOwn(person.agents, botId) ? person.agents[botId] : null
  }
  // 0 hidden, 1 reader, 2 editor, 3 owner, 4 superadmin.
  const rankOf = (botId) => {
    const person = viewer()
    if (person === undefined || rt.botOf(botId) === undefined) return 0
    if (person.role === 'superadmin') return SUPER
    return RANK[grantOf(person, botId)] ?? 0
  }
  // Talking to a Main Bot is using its powers over the whole team.
  const writeRankOf = botId => (rt.isMain(botId) && !superadmin() ? Math.min(rankOf(botId), RANK.reader) : rankOf(botId))
  const roomOfAny = id => rt.roomOf(id) ?? rt.roomOf(rt.pastOwners.get(id)?.roomId)
  const roomRank = (entry, rank) => {
    if (entry === undefined) return 0
    if (superadmin()) return SUPER
    if (entry.members.length === 0) return 0
    return Math.min(...entry.members.map(rank))
  }

  // The Bot or group chat a Session belongs to; a member's hidden group Session is the group's.
  const sessionTarget = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    if (rt.botOf(id) !== undefined) return { botId: id }
    const ownRoom = rt.roomOf(id)
    if (ownRoom !== undefined) return { roomId: ownRoom.id }
    const group = rt.groupOwners.get(id)
    if (group !== undefined) return { roomId: group.roomId }
    const chat = rt.chatOwners.get(id)
    if (chat !== undefined) return { botId: chat }
    const past = rt.pastOwners.get(id)
    if (past?.roomId !== undefined) return { roomId: past.roomId }
    if (past?.botId !== undefined) return { botId: past.botId }
    return undefined
  }
  const resolve = (target) => {
    if (target === undefined || target.missing) return undefined
    if (target.sessionId !== undefined) return sessionTarget(target.sessionId)
    if (target.roomId !== undefined) return roomOfAny(target.roomId) === undefined ? undefined : { roomId: roomOfAny(target.roomId).id }
    if (target.botId !== undefined) return rt.botOf(target.botId) === undefined ? undefined : { botId: target.botId }
    return undefined
  }
  const levelOf = (target, write) => {
    const found = resolve(target)
    if (found === undefined) return superadmin() ? SUPER : 0
    if (found.roomId !== undefined) return roomRank(rt.roomOf(found.roomId), write ? writeRankOf : rankOf)
    return write ? writeRankOf(found.botId) : rankOf(found.botId)
  }
  const sees = target => levelOf(target, false) >= RANK.reader
  const writes = target => levelOf(target, true) >= RANK.editor
  const manages = target => levelOf(target, false) >= RANK.owner
  const seesId = id => sees({ sessionId: id })
  // An editor of a Main Bot (or of every member of a group with one) is still refused,
  // and is told why rather than called a reader.
  const writeRefusal = (found) => {
    const members = found?.roomId !== undefined ? rt.roomOf(found.roomId)?.members ?? [] : [found?.botId]
    const editsAll = members.every(id => rankOf(id) >= RANK.editor)
    if (editsAll && members.some(id => rt.isMain(id))) return REFUSALS.main
    return found?.roomId !== undefined ? REFUSALS.roomReader : REFUSALS.reader
  }

  // Why the viewer may not call `endpoint` with `body`, or undefined when they may.
  function gate(endpoint, body = {}) {
    const rule = Object.hasOwn(ENDPOINT_RULES, endpoint) ? ENDPOINT_RULES[endpoint] : undefined
    if (rule === undefined) return REFUSALS.noRule
    if (viewer() === undefined) return refusal('bot/auth-required', 'Sign in to Atenea first')
    const kind = ruleKind(rule, body)
    if (kind === 'off') return REFUSALS.off
    if (kind === 'admin' && !superadmin()) return REFUSALS.admin
    if (kind === 'read' || kind === 'write' || kind === 'manage') {
      const raw = rule.target?.(body, rt)
      const targets = raw === undefined ? [{ missing: true }] : raw.anyOf !== undefined ? null : [raw].flat()
      // Seeing any one of the places a file was posted is enough to read it.
      if (targets === null) {
        if (!raw.anyOf.some(sees)) return REFUSALS.notFound
      } else {
        for (const target of targets) {
          if (!sees(target)) return REFUSALS.notFound
          if (kind === 'write' && !writes(target)) return writeRefusal(resolve(target))
          if (kind === 'manage' && !manages(target)) return REFUSALS.owner
        }
      }
    }
    return rule.check?.(body, { superadmin, manages, writes, sees })
  }

  // ---------------------------------------------------------------------------
  // What each person is shown.

  const accessOf = botId => ({
    role: grantOf(viewer(), botId),
    write: writes({ botId }),
    manage: manages({ botId }),
    registered: Object.hasOwn(table('registered'), botId),
  })
  const pick = (entries, keep = seesId) => Object.fromEntries(Object.entries(entries ?? {}).filter(([key]) => keep(key)))
  const flagsOf = id => {
    const own = table('flags')[viewer().id]?.[id] ?? {}
    return Object.fromEntries(['pinned', 'hidden'].filter(key => typeof own[key] === 'boolean').map(key => [key, own[key]]))
  }
  const viewerPrefs = () => table('prefs')[viewer().id] ?? {}

  // A change to what someone is shown without a team change (a new identity claim, a
  // share this host just made) must still reach a window that polls with `since`.
  function viewerRevision(revision) {
    const person = viewer()
    if (person === undefined) return revision
    const agents = Object.entries(person.agents).sort(([a], [b]) => a.localeCompare(b))
    const print = createHash('sha256').update(JSON.stringify([person.id, person.role, person.name, agents, overlayVersion])).digest('base64url').slice(0, 12)
    return `${revision}:${print}`
  }

  function accessView(view) {
    const person = viewer()
    const bots = view.bots.filter(entry => sees({ botId: entry.id })).map(entry => ({ ...entry, ...flagsOf(entry.id), access: accessOf(entry.id) }))
    const rooms = view.rooms.filter(entry => sees({ roomId: entry.id })).map(entry => ({ ...entry, ...flagsOf(entry.id), access: { write: writes({ roomId: entry.id }), manage: manages({ roomId: entry.id }) } }))
    const mainBotIds = view.mainBotIds.filter(id => sees({ botId: id }))
    return {
      ...view,
      revision: viewerRevision(view.revision),
      mainBotId: mainBotIds[0] ?? null,
      mainBotIds,
      bots,
      rooms,
      privateArchives: superadmin() ? view.privateArchives : [],
      exchangeTurns: pick(view.exchangeTurns),
      questions: pick(view.questions),
      views: pick(view.views),
      btwCards: pick(view.btwCards),
      sideChats: pick(view.sideChats),
      agents: superadmin() ? view.agents : [],
      secrets: superadmin() ? view.secrets : [],
      secretRequests: pick(view.secretRequests),
      prefs: { ...view.prefs, ...viewerPrefs() },
      multiuser: true,
      viewer: { id: person.id, name: person.name, email: person.email, role: person.role, superadmin: superadmin() },
    }
  }

  function accessLive(live) {
    const waiting = Object.fromEntries(Object.entries(pick(live.work.waiting)).map(([id, entry]) => [id, {
      bots: (entry.bots ?? []).filter(other => sees({ botId: other })),
      rooms: (entry.rooms ?? []).filter(other => sees({ roomId: other })),
      for: (entry.for ?? []).filter(other => sees({ botId: other })),
    }]))
    return {
      ...live,
      activity: pick(live.activity),
      work: {
        bots: pick(live.work.bots),
        rooms: pick(live.work.rooms),
        approvals: (live.work.approvals ?? []).filter(entry => seesId(entry.sessionId)),
        waiting,
        turns: pick(live.work.turns),
        steered: pick(live.work.steered),
      },
      memoryNews: pick(live.memoryNews),
      learning: pick(live.learning),
      connectors: superadmin() ? live.connectors : [],
    }
  }

  const accessSchedules = value => ({
    ...value,
    tasks: (value?.tasks ?? []).filter(task => (task.roomId !== undefined ? sees({ roomId: task.roomId }) : sees({ botId: task.botId }))),
  })

  // ---------------------------------------------------------------------------
  // Per-person preferences and sidebar marks.

  const viewerPrefsTarget = () => (table('prefs')[viewer().id] ??= {})
  async function setViewerFlags(id, { pinned, hidden }) {
    if (rt.botOf(id) === undefined && rt.roomOf(id) === undefined) throw Object.assign(new Error('Unknown conversation'), { code: 'bot/not-found' })
    const mine = (table('flags')[viewer().id] ??= {})
    const entry = (mine[id] ??= {})
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    await rt.save()
    return { id, ...entry }
  }

  // ---------------------------------------------------------------------------
  // Registration with SLA: a Bot someone creates is theirs; one made before the server
  // was shared, or by a Main Bot's tool, stays with the superadmins until one claims it.

  async function markRegistered(botId) {
    table('registered')[botId] = { by: viewer().id, at: Date.now() }
    overlay(viewer().id, botId, 'owner')
    await rt.save()
  }

  async function registerCreated(created) {
    try {
      await rt.sla.registerAgent(created.id, created.name)
    } catch (error) {
      await rt.deleteBot(created.id).catch(failure => rt.warn('ds-bot: %s not removed after SLA refused it: %s', created.name, failure))
      throw Object.assign(new Error(`Could not register the agent in SLA, so it was not created: ${error?.message ?? error}`), { code: 'bot/refused' })
    }
    await markRegistered(created.id)
    return created
  }

  // After the Bot left the team: SLA forgets it too, but the deletion stands either way.
  async function unregisterDeleted(botId) {
    const known = Object.hasOwn(table('registered'), botId) || grantOf(viewer(), botId) !== null
    delete table('registered')[botId]
    for (const key of overlays.keys()) if (key.endsWith(`\n${botId}`)) overlays.delete(key)
    if (known) await rt.sla.deleteAgent(botId).catch(error => rt.warn('ds-bot: SLA still lists deleted agent %s: %s', botId, error?.message ?? error))
  }

  // ---------------------------------------------------------------------------
  // Sharing and the staff directory, always through SLA with the person's own token.

  const listOf = (value, key) => (Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : Array.isArray(value?.items) ? value.items : [])
  const shareList = value => listOf(value, 'shares').map(entry => ({
    id: String(entry?.staffUserId ?? entry?.id ?? ''),
    email: str(entry?.email),
    name: str(entry?.displayName ?? entry?.name) || str(entry?.email),
    role: entry?.role,
  })).filter(entry => RANK[entry.role] !== undefined)
  const staffList = value => listOf(value, 'staff').map(entry => ({
    id: String(entry?.id ?? ''),
    email: str(entry?.email),
    name: str(entry?.displayName ?? entry?.name) || str(entry?.email),
  })).filter(entry => entry.id !== '')

  const endpoints = {
    async shares(body) {
      return { shares: shareList(await rt.sla.listShares(str(body.botId))) }
    },
    async 'share-add'(body) {
      const botId = str(body.botId)
      if (!SHARE_ROLES.includes(body.role)) throw invalid('Choose editor or reader')
      const staffUserId = str(body.staffUserId).trim()
      const email = str(body.email).trim()
      if (staffUserId === '' && email === '') throw invalid('Name the person to share with')
      await rt.sla.putShare(botId, staffUserId !== '' ? { staffUserId, role: body.role } : { email, role: body.role })
      if (staffUserId !== '') overlay(staffUserId, botId, body.role)
      return endpoints.shares({ botId })
    },
    async 'share-remove'(body) {
      const botId = str(body.botId)
      const staffUserId = str(body.staffUserId).trim()
      if (staffUserId === '') throw invalid('Name the person to share with')
      await rt.sla.deleteShare(botId, staffUserId)
      overlay(staffUserId, botId, null)
      return endpoints.shares({ botId })
    },
    async 'staff-search'(body) {
      const q = str(body.q).trim().slice(0, 100)
      if (q.length < 2) throw invalid('Type at least 2 characters to search')
      return { staff: staffList(await rt.sla.searchStaff(q)).slice(0, 20) }
    },
    async 'claim-bot'(body) {
      const target = rt.botOf(str(body.id))
      if (target === undefined) throw Object.assign(new Error('Unknown agent'), { code: 'bot/not-found' })
      await rt.sla.registerAgent(target.id, target.name)
      await markRegistered(target.id)
      return true
    },
    async author(body) {
      return rt.noteAuthor(str(body.requestId), viewer())
    },
    async authors(body) {
      const wanted = ids(body.ids).slice(0, 200)
      return Object.fromEntries(wanted.map(id => [id, rt.authorOf(id)]).filter(([, author]) => author !== undefined))
    },
  }

  async function accessEndpoint(endpoint, body = {}) {
    if (!rt.multiuser) throw Object.assign(new Error('Sharing is only available on a shared Atenea server'), { code: 'bot/unavailable' })
    return endpoints[endpoint](body)
  }

  // ---------------------------------------------------------------------------
  // Audit: every change goes to SLA's log, without waiting for it.

  const DETAIL_KEYS = ['role', 'staffUserId', 'email', 'mode', 'choice', 'approve', 'attached', 'main', 'scope', 'outcome']
  function auditDetail(body) {
    const detail = { fields: Object.keys(body ?? {}).filter(key => key !== 'endpoint').sort() }
    for (const key of DETAIL_KEYS) if (['string', 'boolean', 'number'].includes(typeof body?.[key])) detail[key] = body[key]
    if (typeof body?.text === 'string') detail.length = body.text.length
    return detail
  }
  // Named by the ids the call gave, so a Bot or group it deleted is still named.
  function auditTarget(endpoint, body) {
    const raw = ENDPOINT_RULES[endpoint]?.target?.(body ?? {}, rt)
    const first = raw === undefined || raw.anyOf !== undefined || raw.missing ? undefined : [raw].flat()[0]
    const found = first?.sessionId !== undefined ? sessionTarget(first.sessionId) : first
    if (found?.roomId) return { targetType: 'group', targetId: found.roomId }
    if (found?.botId) return { targetType: 'agent', targetId: found.botId }
    return { targetType: 'team', targetId: '' }
  }
  // What a create made is named by its result, which the body could not name.
  const MADE = { 'create-bot': 'agent', 'duplicate-bot': 'agent', 'create-room': 'group' }
  function auditEndpoint(endpoint, body, result) {
    const rule = ENDPOINT_RULES[endpoint]
    if (rule === undefined || !audited(rule, ruleKind(rule, body ?? {}))) return
    const target = Object.hasOwn(MADE, endpoint) && typeof result?.id === 'string'
      ? { targetType: MADE[endpoint], targetId: result.id }
      : auditTarget(endpoint, body)
    rt.sla.audit({ action: endpoint, ...target, detail: auditDetail(body) })
  }

  // Bots acting through their own tools, outside any request, keep their team powers.
  const teamMemoryWritable = () => !rt.multiuser || viewer() === undefined || superadmin()
  const actorName = () => (rt.multiuser ? viewer()?.name : undefined)

  Object.assign(rt, {
    gate, accessView, accessLive, accessSchedules, viewerRevision, viewerPrefsTarget, setViewerFlags,
    registerCreated, unregisterDeleted, accessEndpoint, auditEndpoint, teamMemoryWritable, actorName,
    access: { sees, writes, manages, superadmin, sessionTarget },
  })
}
