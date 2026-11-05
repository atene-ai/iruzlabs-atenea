import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { ENDPOINT_RULES, REFUSALS } from '../src/host/access.js'
import { authorLabel, withAuthors } from '../src/host/attribution.js'
import { lineText } from '../src/host/groups.js'
import { multiuserSettings, verifyIdentity } from '../src/host/identity.js'
import { SHARED_RULES } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

// A key that only these tests use; the gateway signs with its own.
const KEY = 'unit-test-identity-key'.padEnd(40, '-')
const SLA = 'https://sla.example.test/base'
const NOW = () => Math.floor(Date.now() / 1000)

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function sign(claims, { key = KEY, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const head = `${b64(header)}.${b64(claims)}`
  return `${head}.${createHmac('sha256', key).update(head).digest('base64url')}`
}
const claimsOf = extra => ({ iss: 'atenea-gateway', aud: 'ds-bot', iat: NOW(), exp: NOW() + 60, sub: 'u-ana', email: 'ana@example.com', name: 'Ana García', role: 'product_lead', agents: {}, ...extra })

// Ana owns b1, reads b2 and edits b4; b3 is not shared with her. r1's members are hers to
// write, r2 has b3 in it, r3 has b2, which she only reads.
const ANA = claimsOf({ agents: { b1: 'owner', b2: 'reader', b4: 'editor' } })
const BOSS = claimsOf({ sub: 'u-boss', name: 'Bea Boss', email: 'bea@example.com', role: 'superadmin', agents: {} })
const MAIN_EDITOR = claimsOf({ sub: 'u-luis', name: 'Luis', email: 'luis@example.com', agents: { m1: 'editor', b1: 'owner' } })

const botRecord = (id, name, extra = {}) => ({ id, sessionId: id, name, role: '', instructions: '', createdAt: 1, ...extra })
function team() {
  return {
    version: 1,
    revision: 1,
    mainBotIds: ['m1'],
    bots: {
      m1: botRecord('m1', 'Chief'),
      b1: botRecord('b1', 'Owned'),
      b2: botRecord('b2', 'Shared'),
      b3: botRecord('b3', 'Hidden'),
      b4: botRecord('b4', 'Edited'),
    },
    rooms: {
      r1: { id: 'r1', sessionId: 'r1', name: 'Mine', members: ['b1', 'b4'], admin: 'b1', log: [], seq: 0, seen: {}, createdAt: 1 },
      r2: { id: 'r2', sessionId: 'r2', name: 'Secret', members: ['b1', 'b3'], admin: 'b3', log: [{ seq: 1, who: 'Hidden', botId: 'b3', text: 'see file', files: [{ attachmentId: 'f1', name: 'a.txt' }] }], seq: 1, seen: {}, createdAt: 1 },
      r3: { id: 'r3', sessionId: 'r3', name: 'Look', members: ['b1', 'b2'], admin: 'b1', log: [{ seq: 1, who: 'User', author: 'Ana García', authorId: 'u-ana', text: 'hello' }], seq: 1, seen: {}, createdAt: 1 },
    },
    exchanges: [
      { id: 'x1', from: 'b1', to: 'b3', text: 'secret work', role: 'request', time: 1 },
      { id: 'x2', from: 'b1', to: 'b2', text: 'shared work', role: 'request', time: 2 },
    ],
    exchangeTurns: { b3: [1], b2: [2] },
    questions: { b3: { id: 'q3', questions: [] }, b2: { id: 'q2', questions: [] } },
    secretRequests: { b2: [{ id: 'sr1', sessionId: 'b2', name: 'KEY_ONE', purpose: 'p', kind: 'fill', status: 'pending', askedAt: 1 }], b3: [{ id: 'sr3', sessionId: 'b3', name: 'KEY_TWO', purpose: 'p', kind: 'fill', status: 'pending', askedAt: 1 }], b4: [{ id: 'sr4', sessionId: 'b4', name: 'KEY_THREE', purpose: 'p', kind: 'fill', status: 'pending', askedAt: 1 }] },
  }
}

// Enough of the DSH services for the roster to make Sessions, and a fake SLA.
function start(state = team(), { multiuser = true, sla } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-multiuser-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const prompts = []
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {}, steer: () => {} } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request); return { ok: true } },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  let feedRoute
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.methods.includes('POST')) route = options
    else feedRoute = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, ...(multiuser ? { multiuser: true, identitySecret: KEY, slaUrl: SLA } : {}) })
  const slaCalls = []
  rt.slaFetch = async (url, init) => {
    const call = { url: String(url), method: init.method, auth: init.headers.Authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    slaCalls.push(call)
    const answer = sla?.(call) ?? { status: 200, body: {} }
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body }
  }
  const request = (endpoint, payload, claims, headers = {}) => new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { ...(claims ? { 'x-atenea-identity': sign(claims), 'x-atenea-sla-token': 'test-sla-token' } : {}), ...headers },
    body: JSON.stringify({ endpoint, payload }),
  })
  const raw = (endpoint, payload, claims, headers) => route.fetch(request(endpoint, payload, claims, headers))
  const call = async (endpoint, payload, claims = ANA) => (await raw(endpoint, payload, claims)).json()
  // The gate alone, as `claims` would meet it.
  const gate = (endpoint, body, claims) => rt.runAs({ identity: verifyIdentity(sign(claims), KEY).identity }, () => rt.gate(endpoint, body))
  const feed = (claims, signal) => feedRoute.fetch(new Request('http://localhost/api/bot/feed', { headers: claims ? { 'x-atenea-identity': sign(claims) } : {}, signal }))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, call, raw, gate, feed, prompts, slaCalls, stop }
}

// ---------------------------------------------------------------------------
// Identity

test('a signed identity from the gateway is accepted, with its agents and role', () => {
  const { identity, error } = verifyIdentity(sign({ ...ANA, agents: { ...ANA.agents, b9: 'admin', __proto__: null } }), KEY)
  assert.equal(error, undefined)
  assert.equal(identity.id, 'u-ana')
  assert.equal(identity.name, 'Ana García')
  assert.equal(identity.role, 'product_lead')
  assert.deepEqual(identity.agents, { b1: 'owner', b2: 'reader', b4: 'editor' })
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.agents))
  // A list of audiences that names ds-bot is fine too.
  assert.equal(verifyIdentity(sign({ ...ANA, aud: ['other', 'ds-bot'] }), KEY).error, undefined)
})

test('an identity that is forged, stale, or for someone else is refused', () => {
  const refused = (token, why, key = KEY) => {
    const result = verifyIdentity(token, key)
    assert.equal(result.identity, undefined, why)
    assert.ok(result.error, why)
  }
  const good = sign(ANA)
  const [head, body] = good.split('.')
  refused('', 'empty')
  refused(undefined, 'missing')
  refused('a.b', 'two parts')
  refused(`${head}.${body}.`, 'no signature')
  refused(`${head}.${body}.@@@`, 'not base64url')
  refused(sign(ANA, { key: 'another-key'.padEnd(40, '!') }), 'other key')
  refused(`${head}.${b64({ ...ANA, role: 'superadmin' })}.${good.split('.')[2]}`, 'claims changed after signing')
  refused(sign(ANA, { header: { alg: 'none' } }), 'alg none')
  refused(`${b64({ alg: 'none' })}.${body}.`, 'unsigned')
  refused(sign(ANA, { header: { alg: 'HS512' } }), 'other algorithm')
  refused(sign(ANA, { header: { alg: 'HS256', typ: 'other' } }), 'other type')
  refused(sign({ ...ANA, iss: 'someone' }), 'issuer')
  refused(sign({ ...ANA, aud: 'other-app' }), 'audience')
  refused(sign({ ...ANA, iat: NOW() - 200, exp: NOW() - 30 }), 'expired')
  refused(sign({ ...ANA, iat: NOW() + 120, exp: NOW() + 180 }), 'issued in the future')
  refused(sign({ ...ANA, exp: NOW() + 600 }), 'lives longer than 120 s')
  refused(sign({ ...ANA, exp: undefined }), 'no expiry')
  refused(sign({ ...ANA, sub: '' }), 'no subject')
  refused(sign({ ...ANA, role: 'root' }), 'unknown role')
  refused(good, 'short key', 'short')
  assert.ok(verifyIdentity(good, undefined).error, 'no key')
})

test('multiuser mode and its settings come from the plugin config, then the environment', () => {
  assert.deepEqual(multiuserSettings({}, {}), { multiuser: false, secret: undefined, slaUrl: undefined })
  assert.equal(multiuserSettings({}, { ATENEA_MULTIUSER: '1' }).multiuser, true)
  assert.equal(multiuserSettings({}, { ATENEA_MULTIUSER: 'yes' }).multiuser, false)
  assert.deepEqual(multiuserSettings({ multiuser: true, identitySecret: 'k', slaUrl: 'u' }, { ATENEA_IDENTITY_SECRET: 'env', SLA_URL: 'env' }), { multiuser: true, secret: 'k', slaUrl: 'u' })
})

test('every /api/bot call needs a valid identity, reads too', async (t) => {
  const { raw, stop } = start()
  t.after(stop)
  for (const [claims, headers] of [[undefined, {}], [undefined, { 'x-atenea-identity': 'nonsense' }], [{ ...ANA, aud: 'other' }, {}]]) {
    const response = await raw('state', {}, claims, headers)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'bot/auth-required', message: 'Sign in to Atenea first', details: {} } })
  }
  assert.equal((await raw('state', {}, ANA)).status, 200)
})

test('the live feed needs an identity too, and tells each person only about their Bots', async (t) => {
  const { ctx, rt, feed, stop } = start()
  t.after(stop)
  await rt.load()
  assert.equal((await feed(undefined)).status, 401)
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await feed(ANA, abort.signal)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const readFor = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const next = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve(null), until - Date.now()))])
      if (next === null || next.done) break
      seen += decoder.decode(next.value)
    }
  }
  const stream = ctx.listeners.get('agent/assistant-stream')[0]
  stream({ agent: { id: 'b3' }, frame: { type: 'start', attemptId: 'hidden-attempt', turn: 7 } })
  stream({ agent: { id: 'b2' }, frame: { type: 'start', attemptId: 'shared-attempt', turn: 7 } })
  await readFor(50)
  assert.match(seen, /event: hello/)
  assert.match(seen, /shared-attempt/)
  assert.doesNotMatch(seen, /hidden-attempt/)
})

// ---------------------------------------------------------------------------
// Visibility

test('the team view shows each person only the Bots and groups shared with them', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const ana = (await call('state', {})).value
  assert.equal(ana.multiuser, true)
  assert.deepEqual(ana.viewer, { id: 'u-ana', name: 'Ana García', email: 'ana@example.com', role: 'product_lead', superadmin: false })
  assert.deepEqual(ana.bots.map(bot => bot.id).sort(), ['b1', 'b2', 'b4'])
  assert.deepEqual(Object.fromEntries(ana.bots.map(bot => [bot.id, bot.access])), {
    b1: { role: 'owner', write: true, manage: true, registered: false },
    b2: { role: 'reader', write: false, manage: false, registered: false },
    b4: { role: 'editor', write: true, manage: false, registered: false },
  })
  // A group shows when every member does; r3 is read-only because Ana only reads b2.
  assert.deepEqual(ana.rooms.map(room => room.id).sort(), ['r1', 'r3'])
  assert.deepEqual(ana.rooms.find(room => room.id === 'r3').access, { write: false, manage: false })
  assert.deepEqual(ana.rooms.find(room => room.id === 'r1').access, { write: true, manage: false })
  assert.equal(ana.rooms.find(room => room.id === 'r3').preview, 'Ana García：hello')
  // The Main Bot has no owner in SLA yet, so only superadmins see it.
  assert.deepEqual(ana.mainBotIds, [])
  assert.equal(ana.mainBotId, null)
  assert.deepEqual(Object.keys(ana.exchangeTurns), ['b2'])
  assert.deepEqual(Object.keys(ana.questions), ['b2'])
  assert.deepEqual(Object.keys(ana.secretRequests).sort(), ['b2', 'b4'])
  assert.deepEqual(ana.agents, [])
  assert.deepEqual(ana.secrets, [])
  assert.deepEqual(ana.privateArchives, [])
  assert.equal(ana.auth.required, false)
  assert.equal(ana.auth.user.email, 'ana@example.com')

  const boss = (await call('state', {}, BOSS)).value
  assert.deepEqual(boss.bots.map(bot => bot.id).sort(), ['b1', 'b2', 'b3', 'b4', 'm1'])
  assert.deepEqual(boss.rooms.map(room => room.id).sort(), ['r1', 'r2', 'r3'])
  assert.deepEqual(boss.mainBotIds, ['m1'])
  assert.equal(boss.viewer.superadmin, true)
  assert.deepEqual(boss.bots.find(bot => bot.id === 'b3').access, { role: null, write: true, manage: true, registered: false })
})

test('the same team revision differs per person, so a changed share reaches a polling window', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const first = (await call('state', {})).value
  const same = (await call('state', { since: first.revision, models: first.modelsKey }, ANA)).value
  assert.equal(same.unchanged, true)
  const more = (await call('state', { since: first.revision, models: first.modelsKey }, { ...ANA, agents: { ...ANA.agents, b3: 'reader' } })).value
  assert.equal(more.unchanged, undefined)
  assert.ok(more.bots.some(bot => bot.id === 'b3'))
})

test('every read of a hidden Bot or group answers as if it did not exist', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const notFound = { ok: false, error: { code: 'bot/not-found', message: 'Unknown agent', details: {} } }
  assert.deepEqual(await call('chat', { botId: 'b3' }), notFound)
  assert.deepEqual(await call('run-stats', { botId: 'b3' }), notFound)
  assert.deepEqual(await call('exchange', { a: 'b1', b: 'b3' }), notFound)
  assert.deepEqual(await call('exchange-text', { id: 'x1' }), notFound)
  assert.deepEqual(await call('earlier', { sessionId: 'b3' }), notFound)
  assert.deepEqual(await call('thinking', { sessionId: 'b3', turn: 1 }), notFound)
  assert.deepEqual(await call('room-progress', { roomId: 'r2' }), notFound)
  assert.deepEqual(await call('memory-view', { botId: 'b3' }), notFound)
  assert.deepEqual(await call('memory-history', { roomId: 'r2' }), notFound)
  assert.deepEqual(await call('file-text', { file: { attachmentId: 'f1' } }), notFound)
  // A Bot that does not exist looks the same as a hidden one.
  assert.deepEqual(await call('chat', { botId: 'nope' }), notFound)
  // What she may see still answers.
  const shared = await call('exchange', { a: 'b1', b: 'b2' })
  assert.equal(shared.ok, true)
  assert.deepEqual(shared.value.map(entry => entry.id), ['x2'])
})

// ---------------------------------------------------------------------------
// Roles: every endpoint of the channel has a rule, and every write refuses a reader.

const channelEndpoints = () => {
  const source = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const handle = source.slice(source.indexOf('const handle = async'))
  return [...new Set([...handle.matchAll(/^\s*case '([^']+)':/gm)].map(match => match[1]))]
}

test('every endpoint of the channel has an access rule, and every rule an endpoint', () => {
  const endpoints = channelEndpoints()
  assert.ok(endpoints.length > 90, `found ${endpoints.length} endpoints`)
  assert.deepEqual(endpoints.filter(endpoint => !Object.hasOwn(ENDPOINT_RULES, endpoint)), [])
  assert.deepEqual(Object.keys(ENDPOINT_RULES).filter(endpoint => !endpoints.includes(endpoint)), [])
  for (const [endpoint, rule] of Object.entries(ENDPOINT_RULES)) {
    const kinds = typeof rule.kind === 'function' ? [rule.kind({}), rule.kind({ requestId: 'x', scope: 'team' })] : [rule.kind]
    for (const kind of kinds) {
      assert.ok(['any', 'read', 'write', 'manage', 'create', 'admin', 'off'].includes(kind), `${endpoint}: ${kind}`)
      if (['read', 'write', 'manage'].includes(kind)) assert.equal(typeof rule.target, 'function', `${endpoint} names no target`)
    }
  }
})

test('an endpoint without a rule is refused on a shared server', async (t) => {
  const { gate, stop } = start()
  t.after(stop)
  assert.deepEqual(gate('brand-new-endpoint', {}, BOSS), REFUSALS.noRule)
})

// A body that names `id` everywhere a rule could look for its target.
// A group probe names that group's members, for the calls that take Bots.
const probe = (id) => {
  const bots = team().rooms[id]?.members ?? [id]
  return { id, botId: id, sessionId: id, roomId: id, target: id, a: id, b: id, members: bots, add: bots, requestId: { b2: 'sr1', b3: 'sr3', b4: 'sr4' }[id] ?? 'none', chatId: id, file: { attachmentId: id } }
}
// Their targets are looked up in what only runs live (pending approvals, side chats,
// learning proposals); one that is not there is refused as not found.
const LOOKED_UP = new Set(['approval-answer', 'learning-answer', 'side-cancel', 'side-close'])

test('every write endpoint refuses a reader, and every manage endpoint an editor', async (t) => {
  const { gate, stop } = start()
  t.after(stop)
  const readerMessages = [REFUSALS.reader.message, REFUSALS.roomReader.message]
  for (const endpoint of channelEndpoints()) {
    const rule = ENDPOINT_RULES[endpoint]
    const kind = typeof rule.kind === 'function' ? rule.kind(probe('b2')) : rule.kind
    if (kind === 'write') {
      // b2 is a Bot Ana reads, r3 a group with it: one of the two is what the endpoint acts on.
      const answers = [gate(endpoint, probe('b2'), ANA), gate(endpoint, probe('r3'), ANA)]
      assert.ok(answers.every(answer => answer !== undefined), `${endpoint} let a reader through`)
      if (LOOKED_UP.has(endpoint)) assert.ok(answers.every(answer => answer.code === 'bot/not-found'), endpoint)
      else assert.ok(answers.some(answer => readerMessages.includes(answer.message)), `${endpoint}: ${JSON.stringify(answers)}`)
      // The same call on what she edits passes the gate.
      if (!LOOKED_UP.has(endpoint)) assert.ok([gate(endpoint, probe('b4'), ANA), gate(endpoint, probe('r1'), ANA)].includes(undefined), `${endpoint} refused an editor`)
    } else if (kind === 'manage') {
      assert.deepEqual([gate(endpoint, probe('b4'), ANA), gate(endpoint, probe('r1'), ANA)].find(answer => answer?.code === 'bot/forbidden'), REFUSALS.owner, endpoint)
      assert.ok([gate(endpoint, probe('b1'), ANA), gate(endpoint, probe('r1'), BOSS)].includes(undefined), `${endpoint} refused an owner`)
    } else if (kind === 'admin') {
      assert.deepEqual(gate(endpoint, probe('b1'), ANA), REFUSALS.admin, endpoint)
      assert.equal(gate(endpoint, probe('b1'), BOSS), undefined, endpoint)
    } else if (kind === 'read') {
      assert.deepEqual(gate(endpoint, probe('b3'), ANA)?.code, 'bot/not-found', endpoint)
    } else if (kind === 'off') {
      assert.deepEqual(gate(endpoint, {}, BOSS), REFUSALS.off, endpoint)
    } else {
      assert.equal(gate(endpoint, {}, ANA), undefined, endpoint)
    }
  }
})

test('the channel applies the rules: a reader can read but not send, change or delete', async (t) => {
  const { call, prompts, stop } = start()
  t.after(stop)
  const reader = { ok: false, error: { code: 'bot/forbidden', message: 'Readers can only view this agent', details: {} } }
  assert.deepEqual(await call('send', { sessionId: 'b2', text: 'hi' }), reader)
  assert.deepEqual(await call('update-bot', { id: 'b2', instructions: 'new' }), reader)
  assert.deepEqual(await call('answer-question', { sessionId: 'b2', questionId: 'q2', answer: {} }), reader)
  assert.deepEqual(await call('secret-set', { requestId: 'sr1', value: 'x' }), reader)
  assert.deepEqual(await call('send', { sessionId: 'r3', text: 'hi' }), { ok: false, error: { code: 'bot/forbidden', message: 'Readers can only view this group chat', details: {} } })
  assert.deepEqual((await call('delete-bot', { id: 'b4' })).error.message, 'Only the owner of this agent can do this')
  assert.equal(prompts.length, 0)
  assert.deepEqual(await call('run-stats', { botId: 'b2' }), { ok: true, value: null })
  assert.deepEqual(await call('room-progress', { roomId: 'r3' }), { ok: true, value: [] })
  // An editor's message goes through, under her name.
  assert.equal((await call('send', { sessionId: 'b4', text: 'hi' })).ok, true)
  assert.equal(prompts.length, 1)
  assert.deepEqual((await call('authors', { ids: [prompts[0].requestId] })).value, { [prompts[0].requestId]: { id: 'u-ana', name: 'Ana García' } })
})

test('a Main Bot, team settings, the team memory and server folders are for superadmins only', async (t) => {
  const { call, gate, stop } = start()
  t.after(stop)
  assert.deepEqual(gate('send', { sessionId: 'm1', text: 'hi' }, MAIN_EDITOR), REFUSALS.main)
  assert.equal(gate('send', { sessionId: 'm1', text: 'hi' }, BOSS), undefined)
  assert.deepEqual(gate('set-main', { id: 'b1' }, ANA), REFUSALS.admin)
  assert.deepEqual(gate('memory-forget', { botId: 'b1', scope: 'team', text: 'x' }, ANA), REFUSALS.admin)
  assert.equal(gate('memory-forget', { botId: 'b1', text: 'x' }, ANA), undefined)
  assert.deepEqual(gate('set-prefs', { defaultBotModel: 'a/b' }, ANA), REFUSALS.admin)
  assert.equal(gate('set-prefs', { theme: 'dark' }, ANA), undefined)
  assert.deepEqual(gate('update-bot', { id: 'b1', workDir: '/srv' }, ANA), REFUSALS.admin)
  assert.deepEqual(gate('update-bot', { id: 'b4', private: true }, ANA), REFUSALS.owner)
  assert.equal(gate('update-bot', { id: 'b1', private: true }, ANA), undefined)
  assert.deepEqual(gate('create-bot', { name: 'X', workDir: '/srv' }, ANA), REFUSALS.admin)
  assert.equal(gate('create-bot', { name: 'X' }, ANA), undefined)
  assert.deepEqual(gate('secret-set', { name: 'TEAM_KEY', value: 'x' }, ANA), REFUSALS.admin)
  assert.deepEqual(gate('auth-dev-login', { email: 'x' }, BOSS), REFUSALS.off)
  assert.equal((await call('auth-start', {}, BOSS)).error.message, 'Sign-in is handled by the Atenea server')
  // A group with a member Ana cannot write is not hers to start or change.
  assert.deepEqual(gate('create-room', { members: ['b1', 'b2'] }, ANA), REFUSALS.reader)
  assert.deepEqual(gate('update-room', { id: 'r1', add: ['b3'] }, ANA), REFUSALS.notFound)
  assert.equal(gate('create-room', { members: ['b1', 'b4'] }, ANA), undefined)
  assert.deepEqual(gate('delete-room', { id: 'r1' }, ANA), REFUSALS.owner)
})

test('display preferences and sidebar marks are each person\'s own', async (t) => {
  const { call, rt, stop } = start()
  t.after(stop)
  assert.equal((await call('set-prefs', { theme: 'dusk' })).ok, true)
  assert.equal((await call('set-flags', { id: 'b2', pinned: true })).ok, true)
  assert.equal(rt.state.prefs.theme, undefined)
  const ana = (await call('state', {})).value
  assert.equal(ana.prefs.theme, 'dusk')
  assert.equal(ana.bots.find(bot => bot.id === 'b2').pinned, true)
  const boss = (await call('state', {}, BOSS)).value
  assert.equal(boss.prefs.theme, undefined)
  assert.equal(boss.bots.find(bot => bot.id === 'b2').pinned, undefined)
})

// ---------------------------------------------------------------------------
// Creating, sharing and deleting through SLA

test('a new Bot is registered in SLA to the person who made it', async (t) => {
  const { call, slaCalls, rt, stop } = start(team(), { sla: () => ({ status: 200, body: {} }) })
  t.after(stop)
  const made = await call('create-bot', { name: 'Writer' })
  assert.equal(made.ok, true, JSON.stringify(made))
  const id = made.value.id
  const register = slaCalls.find(entry => entry.method === 'PUT')
  assert.equal(register.url, `${SLA}/api/atenea/agents/${id}`)
  assert.equal(register.auth, 'Bearer test-sla-token')
  assert.deepEqual(register.body, { name: 'Writer' })
  assert.ok(rt.state.multiuser.registered[id])
  // The gateway's claim may not name the new Bot yet; she sees it as its owner anyway.
  const view = (await call('state', {})).value
  assert.deepEqual(view.bots.find(bot => bot.id === id)?.access, { role: 'owner', write: true, manage: true, registered: true })
  // The audit line goes to SLA without holding the answer up.
  await new Promise(resolve => setImmediate(resolve))
  const audit = slaCalls.find(entry => entry.url.endsWith('/api/atenea/audit'))
  assert.deepEqual(audit.body, { action: 'create-bot', targetType: 'agent', targetId: id, detail: { fields: ['name'] } })
})

test('when SLA refuses the registration, the new Bot is taken back', async (t) => {
  const { call, rt, stop } = start(team(), { sla: entry => (entry.method === 'PUT' ? { status: 503, body: { message: 'down for maintenance' } } : { status: 200, body: {} }) })
  t.after(stop)
  const made = await call('create-bot', { name: 'Writer' })
  assert.equal(made.ok, false)
  assert.equal(made.error.message, 'Could not register the agent in SLA, so it was not created: SLA answered 503: down for maintenance')
  assert.equal(Object.values(rt.state.bots).some(bot => bot.name === 'Writer'), false)
})

test('an audit that fails never blocks the action', async (t) => {
  const { call, stop } = start(team(), { sla: entry => (entry.url.endsWith('/audit') ? { status: 500, body: {} } : { status: 200, body: {} }) })
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b1', role: 'Ops' })).ok, true)
})

test('owners list, add and remove shares, and search staff, through SLA', async (t) => {
  let shares = [{ staffUserId: 'u-ana', email: 'ana@example.com', displayName: 'Ana García', role: 'owner' }]
  const { call, slaCalls, gate, stop } = start(team(), {
    sla: (entry) => {
      if (entry.url.includes('/api/atenea/staff')) return { status: 200, body: [{ id: 'u-luis', email: 'luis@example.com', displayName: 'Luis' }, { email: 'no-id@example.com' }] }
      if (entry.method === 'PUT') shares = [...shares, { ...entry.body, email: 'luis@example.com', displayName: 'Luis' }]
      if (entry.method === 'DELETE') shares = shares.filter(share => share.staffUserId !== 'u-luis')
      return { status: 200, body: entry.url.endsWith('/shares') ? shares : {} }
    },
  })
  t.after(stop)
  const found = await call('staff-search', { q: 'lu' })
  assert.deepEqual(found.value, { staff: [{ id: 'u-luis', email: 'luis@example.com', name: 'Luis' }] })
  assert.equal(slaCalls.at(-1).url, `${SLA}/api/atenea/staff?q=lu`)
  assert.equal((await call('staff-search', { q: 'l' })).error.message, 'Type at least 2 characters to search')

  const added = await call('share-add', { botId: 'b1', staffUserId: 'u-luis', role: 'editor' })
  assert.deepEqual(added.value.shares.map(share => [share.id, share.role]), [['u-ana', 'owner'], ['u-luis', 'editor']])
  assert.deepEqual(slaCalls.find(entry => entry.method === 'PUT').body, { staffUserId: 'u-luis', role: 'editor' })
  assert.equal((await call('share-add', { botId: 'b1', staffUserId: 'u-luis', role: 'owner' })).error.message, 'Choose editor or reader')
  // Luis edits b1 at once, before the gateway's claim names it.
  assert.equal(gate('send', { sessionId: 'b1', text: 'hi' }, { ...MAIN_EDITOR, agents: {} }), undefined)

  const removed = await call('share-remove', { botId: 'b1', staffUserId: 'u-luis' })
  assert.deepEqual(removed.value.shares.map(share => share.id), ['u-ana'])
  assert.equal(slaCalls.find(entry => entry.method === 'DELETE').url, `${SLA}/api/atenea/agents/b1/shares/u-luis`)
  // And loses it at once, even while his claim still names it.
  assert.deepEqual(gate('chat', { botId: 'b1' }, { ...MAIN_EDITOR, agents: { b1: 'editor' } }), REFUSALS.notFound)

  // Only the owner shares.
  assert.equal((await call('shares', { botId: 'b4' })).error.message, 'Only the owner of this agent can do this')
  assert.equal((await call('share-add', { botId: 'b2', staffUserId: 'u-luis', role: 'reader' })).error.message, 'Only the owner of this agent can do this')
})

test('deleting a Bot tells SLA, and a superadmin can claim a Bot made before sharing', async (t) => {
  const { call, slaCalls, rt, stop } = start()
  t.after(stop)
  assert.equal((await call('delete-bot', { id: 'b1' })).ok, true)
  assert.ok(slaCalls.some(entry => entry.method === 'DELETE' && entry.url === `${SLA}/api/atenea/agents/b1`))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(slaCalls.find(entry => entry.url.endsWith('/audit')).body, { action: 'delete-bot', targetType: 'agent', targetId: 'b1', detail: { fields: ['id'] } })
  assert.equal((await call('claim-bot', { id: 'b3' })).error.message, 'Only a superadmin can do this')
  assert.equal((await call('claim-bot', { id: 'b3' }, BOSS)).ok, true)
  assert.deepEqual(slaCalls.find(entry => entry.method === 'PUT' && entry.url.endsWith('/agents/b3')).body, { name: 'Hidden' })
  assert.equal(rt.state.multiuser.registered.b3.by, 'u-boss')
  assert.equal((await call('state', {}, BOSS)).value.bots.find(bot => bot.id === 'b3').access.registered, true)
})

test('without an SLA token or address, SLA calls fail with a clear message', async (t) => {
  const { raw, stop } = start()
  t.after(stop)
  const noToken = await (await raw('staff-search', { q: 'ana' }, ANA, { 'x-atenea-sla-token': '' })).json()
  assert.equal(noToken.error.code, 'bot/auth-required')
})

// ---------------------------------------------------------------------------
// Attribution

test('a person\'s messages carry their name for the Bots, in chats and in groups', async (t) => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hola' }], source: { kind: 'user', rpcId: 'req-ana-0001' } },
    { role: 'user', content: [{ type: 'text', text: 'unclaimed' }], source: { kind: 'user', rpcId: 'req-none-0001' } },
    { role: 'user', content: [{ type: 'text', text: '[Message from Bob]\nhi' }], source: { kind: 'ds-bot', role: 'request' } },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ]
  const authorOf = id => (id === 'req-ana-0001' ? { id: 'u-ana', name: 'Ana García' } : undefined)
  const named = withAuthors(messages, authorOf)
  assert.equal(named[0].content[0].text, `${authorLabel('Ana García')}\nhola`)
  assert.equal(named[1], messages[1])
  assert.equal(named[2], messages[2])
  // Already named, nothing changes, so a request that goes round again stays the same.
  assert.equal(withAuthors(named, authorOf), named)
  assert.equal(withAuthors(messages, () => undefined), messages)

  assert.equal(lineText({ who: 'User', author: 'Ana García', text: 'ship it' }), 'Ana García (user): ship it')
  assert.equal(lineText({ who: 'User', text: 'ship it' }), 'User: ship it')
  assert.match(SHARED_RULES, /\[From Name\]/)

  const { rt, call, stop } = start()
  t.after(stop)
  assert.equal((await call('author', { sessionId: 'b4', requestId: 'req-ana-0002' })).value, true)
  // The first claim wins; a reader cannot claim in a chat she only reads.
  assert.equal((await call('author', { sessionId: 'b1', requestId: 'req-ana-0002' }, MAIN_EDITOR)).value, false)
  assert.equal((await call('author', { sessionId: 'b2', requestId: 'req-ana-0003' })).error.code, 'bot/forbidden')
  assert.deepEqual(rt.authorOf('req-ana-0002'), { id: 'u-ana', name: 'Ana García' })
  assert.deepEqual(rt.authorFields({ kind: 'user', rpcId: 'req-ana-0002' }), { author: 'Ana García', authorId: 'u-ana' })
  assert.match(rt.runAs({ identity: verifyIdentity(sign(ANA), KEY).identity }, () => rt.actorName()), /Ana García/)
  const section = [...rt.ctx.sections.values()].find(entry => entry.name === 'bot-identity')
  assert.match(section.text({ agent: { id: 'b1' } }), /## Several people share you/)
})

// ---------------------------------------------------------------------------
// Session access, for the gateway's checks of DSH's own Session calls

// b1 has moved on to a second part of its chat, r3's members have their group Sessions
// (b2's with an earlier part) and r3 an earlier part of its own; r1 has b4's group Session.
function partedTeam() {
  const state = team()
  Object.assign(state.bots.b1, { sessionId: 'b1-now', segments: [{ sessionId: 'b1-mid', startedAt: 1, endedAt: 2 }] })
  Object.assign(state.rooms.r3, { sessions: { b1: 'g-r3-b1', b2: 'g-r3-b2' }, segments: { b2: [{ sessionId: 'g-r3-b2-old', startedAt: 1, endedAt: 2 }] }, parts: [{ sessionId: 'r3-old', startedAt: 1, endedAt: 2 }] })
  Object.assign(state.rooms.r1, { sessions: { b4: 'g-r1-b4' } })
  return state
}

// DSH's Session list names the parents of cold subagent Sessions; a live one names its
// own parent on its Agent.
function withSubagents(ctx) {
  const listed = { calls: 0 }
  ctx.sessionController.list = async () => {
    listed.calls += 1
    return { items: [
      { sessionId: 'sub-1', parentSessionId: 'b1-now', origin: 'subagent' },
      { sessionId: 'sub-2', parentSessionId: 'sub-1', origin: 'subagent' },
      { sessionId: 'sub-3', parentSessionId: 'b3', origin: 'subagent' },
      { sessionId: 'dsh-own' },
    ] }
  }
  const agents = new Map([['live-sub', { id: 'live-sub', session: { header: { id: 'live-sub', parentSession: 'g-r3-b2' } } }]])
  const services = ctx.get
  ctx.get = name => (name === 'agents' ? agents : services(name))
  return listed
}

test('session access maps every kind of Bot Session to its Bot and answers with the caller\'s role', async (t) => {
  const { ctx, call, stop } = start(partedTeam())
  t.after(stop)
  const listed = withSubagents(ctx)
  const ids = ['b1', 'b1-now', 'b1-mid', 'b2', 'b3', 'b4', 'm1', 'r1', 'g-r1-b4', 'r2', 'r3', 'g-r3-b1', 'g-r3-b2-old', 'r3-old', 'sub-1', 'sub-2', 'sub-3', 'live-sub', 'dsh-own', 'never-seen']
  const answer = await call('session-access', { sessionIds: ids })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.sessions, {
    // Her own Bot: its first Session, its current part and an earlier part.
    b1: { allowed: 'write', botId: 'b1' },
    'b1-now': { allowed: 'write', botId: 'b1' },
    'b1-mid': { allowed: 'write', botId: 'b1' },
    b2: { allowed: 'read', botId: 'b2' },
    b4: { allowed: 'write', botId: 'b4' },
    // Hidden Bots, a Main Bot not shared with her, and Sessions of DSH's own: nothing,
    // not even whose they are.
    b3: { allowed: 'none' },
    m1: { allowed: 'none' },
    r2: { allowed: 'none' },
    'dsh-own': { allowed: 'none' },
    'never-seen': { allowed: 'none' },
    // A group answers as far as every member allows, its member Sessions too.
    r1: { allowed: 'write', roomId: 'r1' },
    'g-r1-b4': { allowed: 'write', botId: 'b4', roomId: 'r1' },
    r3: { allowed: 'read', roomId: 'r3' },
    'g-r3-b1': { allowed: 'read', botId: 'b1', roomId: 'r3' },
    'g-r3-b2-old': { allowed: 'read', botId: 'b2', roomId: 'r3' },
    'r3-old': { allowed: 'read', roomId: 'r3' },
    // Subagents answer for the Session they were spawned from, however deep.
    'sub-1': { allowed: 'write', botId: 'b1' },
    'sub-2': { allowed: 'write', botId: 'b1' },
    'sub-3': { allowed: 'none' },
    'live-sub': { allowed: 'read', botId: 'b2', roomId: 'r3' },
  })
  // One batch lists DSH's Sessions once, however many it could not place.
  assert.equal(listed.calls, 1)
})

test('session access follows the roles: Main Bots, superadmins and DSH\'s own Sessions', async (t) => {
  const { ctx, call, stop } = start(partedTeam())
  t.after(stop)
  withSubagents(ctx)
  const ask = async (claims, ...sessionIds) => (await call('session-access', { sessionIds }, claims)).value.sessions
  // An editor of a Main Bot still only reads it.
  assert.deepEqual(await ask(MAIN_EDITOR, 'm1', 'b1'), { m1: { allowed: 'read', botId: 'm1' }, b1: { allowed: 'write', botId: 'b1' } })
  // A superadmin writes everywhere, DSH's own Sessions included.
  assert.deepEqual(await ask(BOSS, 'b3', 'sub-3', 'dsh-own', 'r2'), {
    b3: { allowed: 'write', botId: 'b3' },
    'sub-3': { allowed: 'write', botId: 'b3' },
    'dsh-own': { allowed: 'write' },
    r2: { allowed: 'write', roomId: 'r2' },
  })
  // Someone with no shares sees nothing.
  assert.deepEqual(await ask(claimsOf({ sub: 'u-new', agents: {} }), 'b1', 'r1'), { b1: { allowed: 'none' }, r1: { allowed: 'none' } })
})

test('session access takes a bounded batch of ids and needs a shared server', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const refused = async payload => (await call('session-access', payload)).error
  assert.equal((await refused({})).code, 'bot/invalid')
  assert.equal((await refused({ sessionIds: 'b1' })).code, 'bot/invalid')
  assert.equal((await refused({ sessionIds: ['b1', 7] })).code, 'bot/invalid')
  assert.equal((await refused({ sessionIds: [''] })).code, 'bot/invalid')
  assert.equal((await refused({ sessionIds: Array.from({ length: 501 }, (_, index) => `s${index}`) })).code, 'bot/invalid')
  // Repeated ids are answered once.
  assert.deepEqual((await call('session-access', { sessionIds: ['b2', 'b2'] })).value, { sessions: { b2: { allowed: 'read', botId: 'b2' } } })
  const single = start(team(), { multiuser: false })
  t.after(single.stop)
  assert.equal((await single.call('session-access', { sessionIds: ['b1'] }, undefined)).error.code, 'bot/unavailable')
})

// ---------------------------------------------------------------------------
// Off by default

test('without ATENEA_MULTIUSER nothing changes: no identity needed, no access fields', async (t) => {
  const { call, raw, rt, ctx, stop } = start(team(), { multiuser: false })
  t.after(stop)
  assert.equal(rt.multiuser, false)
  const response = await raw('state', {})
  assert.equal(response.status, 200)
  const view = (await response.json()).value
  assert.equal(view.multiuser, undefined)
  assert.equal(view.viewer, undefined)
  assert.deepEqual(view.bots.map(bot => bot.id).sort(), ['b1', 'b2', 'b3', 'b4', 'm1'])
  assert.equal(view.bots[0].access, undefined)
  assert.equal(typeof view.revision, 'number')
  assert.deepEqual((await call('shares', { botId: 'b1' }, undefined)).error, { code: 'bot/unavailable', message: 'Sharing is only available on a shared Atenea server', details: {} })
  assert.equal(rt.noteAuthor('req-any-0001', { id: 'x', name: 'X' }), false)
  assert.equal(rt.teamMemoryWritable(), true)
  const section = [...ctx.sections.values()].find(entry => entry.name === 'bot-identity')
  assert.doesNotMatch(section.text({ agent: { id: 'b1' } }), /Several people share you/)
  assert.equal((await call('set-prefs', { theme: 'dusk' }, undefined)).ok, true)
  assert.equal(rt.state.prefs.theme, 'dusk')
})
