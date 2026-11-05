import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'
import { CRM_CALLBACK_ROUTE, crmFailureText, crmSettings } from '../src/host/crm.js'
import { tokenExpiry } from '../src/host/identity.js'
import { authorizeUrl, createLinkStore, idTokenProblem, parseTokenKey, pkcePair, seal, unseal } from '../src/host/crm-link.js'
import { idArg, idListArg, textArg, wholeArg } from '../src/host/crm-tools.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

// Keys and hosts only these tests use.
const KEY = 'unit-test-identity-key'.padEnd(40, '-')
const SLA = 'https://sla.example.test'
const CRM = 'https://crm.example.test'
const LOGIN = 'https://crm-login.example.test'
const POOL = 'mx-central-1_TESTPOOL'
const CLIENT = 'test-crm-client'
const REDIRECT = 'https://atenea.example.test/api/bot/crm/callback'
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')
const NOW = () => Math.floor(Date.now() / 1000)

const PA1 = '11111111-1111-4111-8111-111111111111'
const PA2 = '22222222-2222-4222-8222-222222222222'
const SUB1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// SLA's workspaces of each account: the CRM subaccounts SUB1 and SUB2.
const WS1 = '33333333-3333-4333-8333-333333333333'
const WS2 = '44444444-4444-4444-8444-444444444444'
const OWN_SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEAD1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LEAD2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CONV = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const CHANNEL = '12121212-1212-4212-8212-121212121212'
const TEMPLATE = '34343434-3434-4434-8434-343434343434'
const STAGE = '56565656-5656-4656-8656-565656565656'

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const sign = (claims) => {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`
  return `${head}.${createHmac('sha256', KEY).update(head).digest('base64url')}`
}
// A JWT-shaped test token: only its `exp` is read on this side.
const testJwt = claims => `${b64({ alg: 'none' })}.${b64(claims)}.test-signature`
const claimsOf = extra => ({ iss: 'atenea-gateway', aud: 'ds-bot', iat: NOW(), exp: NOW() + 60, sub: 'u-ana', email: 'ana@example.com', name: 'Ana García', role: 'product_lead', agents: { b1: 'owner', b2: 'owner', b4: 'editor', b5: 'reader' }, ...extra })
const ANA = claimsOf()
const LUIS = claimsOf({ sub: 'u-luis', name: 'Luis', email: 'luis@example.com', role: 'support', agents: { b1: 'editor', b4: 'editor' } })
const crmIdToken = (extra = {}) => testJwt({ token_use: 'id', iss: `https://cognito-idp.mx-central-1.amazonaws.com/${POOL}`, aud: CLIENT, exp: NOW() + 3600, sub: 'crm-user-1', email: 'ana@client.example', ...extra })

const botRecord = (id, name, extra = {}) => ({ id, sessionId: id, name, role: '', instructions: '', createdAt: 1, ...extra })
function team(work) {
  return {
    version: 1,
    revision: 1,
    mainBotIds: ['m1'],
    bots: {
      m1: botRecord('m1', 'Chief'),
      b1: botRecord('b1', 'Seller', { workDir: work }),
      b2: botRecord('b2', 'Night'),
      b4: botRecord('b4', 'Helper'),
      b5: botRecord('b5', 'Viewer'),
    },
    rooms: {
      r1: { id: 'r1', sessionId: 'r1', name: 'Sales', members: ['b1', 'b4'], admin: 'b1', mode: 'admin', log: [], seq: 0, seen: {}, sessions: { b1: 'g1', b4: 'g4' }, createdAt: 1 },
    },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    multiuser: { registered: { b1: { by: 'u-ana', at: 1 }, b2: { by: 'u-ana', at: 1 }, b4: { by: 'u-luis', at: 1 } } },
  }
}

const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ME = {
  staff: { id: 'u-ana', email: 'ana@example.com', displayName: 'Ana García', role: 'product_lead' },
  accounts: [
    { productAccountId: PA1, productCode: 'sales-os', sourceSystem: 'sales-os', externalId: 'acc-uno', name: 'Cliente Uno', accessLevel: 'operator', workspaces: [{ workspaceId: WS1, externalId: SUB1, name: 'Principal' }] },
    { productAccountId: PA2, productCode: 'sales-os', sourceSystem: 'sales-os', externalId: 'acc-dos', name: 'Cliente Dos', accessLevel: 'viewer', workspaces: [{ workspaceId: WS2, externalId: SUB2, name: 'Principal' }] },
    { productAccountId: '99999999-9999-4999-8999-999999999999', productCode: 'contractors', sourceSystem: 'contractors', externalId: 'x-1', name: 'Other product', accessLevel: 'operator' },
  ],
}

// A shared server with fake SLA, CRM and CRM sign-in; `crm(call)` and `sla(call)` answer
// or return undefined for the default.
function start({ multiuser = true, crm, sla, approval, config = {}, state } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-crm-'))
  const work = join(home, 'work')
  mkdirSync(work)
  writeFileSync(join(home, 'state.json'), JSON.stringify(state ?? team(work)))
  const ctx = fakeContext({ services: approval === undefined ? {} : { approval } })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {}, steer: () => {} } }),
      selectModel: async () => {},
      prompt: async () => ({ ok: true }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const slaToken = testJwt({ exp: NOW() + 3600 })
  const routes = new Map()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes.set(options.path, options)
    return register(options)
  }
  const crmConfig = { apiUrl: CRM, userPoolId: POOL, clientId: CLIENT, cognitoDomain: LOGIN, redirectUri: REDIRECT, tokenKey: TOKEN_KEY, importPollMs: 1, importWaitMs: 200, authorWaitMs: 50, ...config }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, crm: crmConfig, ...(multiuser ? { multiuser: true, identitySecret: KEY, slaUrl: SLA } : {}) })
  const slaCalls = []
  let grants = 0
  rt.slaFetch = async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, auth: init.headers.Authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    slaCalls.push(call)
    const answer = sla?.(call)
    if (answer !== undefined) return answer
    if (call.path === '/api/atenea/me') return json(ME)
    if (call.path === '/api/atenea/grants') return json({ grant: `test-grant-${++grants}-${call.body.mode}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }, 201)
    if (call.path === '/api/atenea/audit') return json({ id: 'a1' }, 201)
    return json({})
  }
  const crmCalls = []
  rt.crmFetch = async (url, init) => {
    const parsed = new URL(url)
    const call = { url: parsed, host: parsed.origin, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: init.method, headers: init.headers, rawBody: init.body }
    if (typeof init.body === 'string') {
      try { call.body = JSON.parse(init.body) } catch { call.body = Object.fromEntries(new URLSearchParams(init.body)) }
    }
    crmCalls.push(call)
    const answer = crm?.(call)
    if (answer !== undefined) return answer
    if (call.host === LOGIN && call.path === '/oauth2/token') return json({ id_token: crmIdToken(), access_token: 'test-access', expires_in: 3600, token_type: 'Bearer', ...(call.body.grant_type === 'authorization_code' ? { refresh_token: 'test-refresh-token' } : {}) })
    if (call.path === '/api/subaccounts/v1') return json([{ id: OWN_SUB, name: 'Mi Sucursal' }])
    return json({ data: [], total: 0 })
  }
  const request = (endpoint, payload, claims, token = slaToken) => new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'x-atenea-identity': sign(claims), ...(token ? { 'x-atenea-sla-token': token } : {}) },
    body: JSON.stringify({ endpoint, payload }),
  })
  const call = async (endpoint, payload = {}, claims = ANA, token) => (await routes.get('/api/bot').fetch(request(endpoint, payload, claims, token))).json()
  // The gateway signs the identity and passes the SLA token on this route as on any other.
  const callback = (query, claims = ANA, token = slaToken) => routes.get(CRM_CALLBACK_ROUTE).fetch(new Request(`http://localhost${CRM_CALLBACK_ROUTE}?${new URLSearchParams(query)}`, { headers: claims ? { 'x-atenea-identity': sign(claims), ...(token ? { 'x-atenea-sla-token': token } : {}) } : {} }))
  let seq = 0
  const emit = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, seq: ++seq, data })
    }
  }
  // A turn in `sessionId` opened by a message with `source`.
  const turn = (sessionId, source, number = seq + 1) => {
    emit(sessionId, 'turn/start', { turn: number })
    emit(sessionId, 'user/message', { content: [{ type: 'text', text: 'hi' }], source })
  }
  // A turn the person wrote in their Bot's own chat, claimed by their window.
  const asked = async (sessionId = 'b1', claims = ANA, token) => {
    const rpcId = `rpc-${sessionId}-${++seq}-test`
    turn(sessionId, { kind: 'user', rpcId })
    assert.equal((await call('author', { sessionId, requestId: rpcId }, claims, token)).value, true)
  }
  const exec = (sessionId = 'b1', extra = {}) => ({ agent: { id: sessionId, session: { id: sessionId } }, callId: `call-${++seq}`, name: 'crm', ...extra })
  const tool = (name, args = {}, sessionId = 'b1', extra) => rt.teamTools.find(entry => entry.name === name).execute(args, exec(sessionId, { name, ...extra }))
  const audits = () => slaCalls.filter(entry => entry.path === '/api/atenea/audit').map(entry => entry.body)
  const settle = () => new Promise(done => setImmediate(done))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, work, routes, call, callback, emit, turn, asked, tool, slaCalls, crmCalls, audits, settle, stop, slaToken }
}

const CRM_TOOLS = ['crm_list_accounts', 'crm_search_leads', 'crm_get_lead', 'crm_create_lead', 'crm_import_leads', 'crm_list_conversations', 'crm_read_messages', 'crm_send_message', 'crm_start_conversation', 'crm_move_stage']

// ---------------------------------------------------------------------------
// Off a shared server

test('without ATENEA_MULTIUSER the CRM tools, route and card are not there', async (t) => {
  const { rt, routes, stop } = start({ multiuser: false })
  t.after(stop)
  assert.deepEqual(rt.teamTools.filter(entry => entry.name.startsWith('crm_')), [])
  assert.equal(routes.has(CRM_CALLBACK_ROUTE), false)
  await assert.rejects(rt.crmEndpoint('crm-view', {}), /only available on a shared Atenea server/)
})

test('on a shared server every CRM tool is a Bot tool and the callback route is registered', async (t) => {
  const { rt, routes, stop } = start()
  t.after(stop)
  assert.deepEqual(rt.teamTools.filter(entry => entry.name.startsWith('crm_')).map(entry => entry.name), CRM_TOOLS)
  for (const name of CRM_TOOLS.slice(1)) assert.ok(rt.teamTools.find(entry => entry.name === name).parameters.required.includes('account'), name)
  assert.deepEqual(routes.get(CRM_CALLBACK_ROUTE).methods, ['GET'])
})

test('settings come from the CRM web app\'s own names, and the region from the pool id', () => {
  const settings = crmSettings({}, { PUBLIC_AWS_COGNITO_USER_POOL_ID: 'mx-central-1_abc', PUBLIC_AWS_COGNITO_USER_POOL_CLIENT_ID: 'client', ATENEA_CRM_WRITES_PER_MINUTE: '12' })
  assert.equal(settings.region, 'mx-central-1')
  assert.equal(settings.clientId, 'client')
  assert.equal(settings.writesPerMinute, 12)
  assert.equal(settings.staffAuthors, false)
  assert.equal(crmSettings({}, {}).writesPerMinute, 30)
  assert.equal(crmSettings({ crm: { apiUrl: 'https://x.example.test/' } }, {}).apiUrl, 'https://x.example.test')
})

// ---------------------------------------------------------------------------
// Who a call acts for

test('a turn the person started acts for them, with their SLA token and accounts', async (t) => {
  const { call, asked, tool, slaCalls, slaToken, stop } = start()
  t.after(stop)
  await call('state')
  await asked()
  const text = await tool('crm_list_accounts')
  assert.match(text, /Acting for Ana García, who asked/)
  assert.match(text, /Cliente Uno · Principal: account "sla:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333", read and change/)
  assert.match(text, /Cliente Dos · Principal: account "sla:22222222-2222-4222-8222-222222222222:44444444-4444-4444-8444-444444444444", read only/)
  assert.doesNotMatch(text, /Other product/)
  const me = slaCalls.find(entry => entry.path === '/api/atenea/me')
  assert.equal(me.auth, `Bearer ${slaToken}`)
})

test('each CRM subaccount of an SLA account is its own account, and its grant names that workspace', async (t) => {
  const WS3 = '55555555-5555-4555-8555-555555555555'
  const SUB3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const me = {
    ...ME,
    accounts: [
      { ...ME.accounts[0], workspaces: [{ workspaceId: WS1, externalId: SUB1, name: 'Principal' }, { workspaceId: WS3, externalId: SUB3, name: 'Norte' }] },
      // An SLA that does not list workspaces yet: its account id is not a CRM subaccount.
      { ...ME.accounts[1], workspaces: undefined },
    ],
  }
  const { call, asked, tool, slaCalls, crmCalls, stop } = start({ sla: entry => (entry.path === '/api/atenea/me' ? json(me) : undefined) })
  t.after(stop)
  await call('state')
  await asked()
  const text = await tool('crm_list_accounts')
  assert.match(text, new RegExp(`Cliente Uno · Principal: account "sla:${PA1}:${WS1}"`))
  assert.match(text, new RegExp(`Cliente Uno · Norte: account "sla:${PA1}:${WS3}"`))
  assert.doesNotMatch(text, /Cliente Dos/)
  await assert.rejects(tool('crm_search_leads', { account: 'Cliente Uno' }), /names several accounts/)
  await tool('crm_search_leads', { account: `sla:${PA1}:${WS3}` })
  const grant = slaCalls.find(entry => entry.path === '/api/atenea/grants')
  assert.equal(grant.body.workspaceId, WS3)
  assert.equal(crmCalls.at(-1).query.subaccountId, SUB3)
})

test('a turn no person started is refused unless the owner allowed it, and then acts for the owner', async (t) => {
  const { call, turn, tool, crmCalls, stop } = start()
  t.after(stop)
  await call('state')
  turn('b2', { kind: SOURCE_KIND, role: 'request', senderSessionId: 'b1' })
  await assert.rejects(tool('crm_search_leads', { account: `sla:${PA1}:${WS1}` }, 'b2'), /No person started this turn.*has not let it use the CRM on its own/)
  assert.equal(crmCalls.length, 0)
  // Someone who is not its registered owner cannot allow it.
  assert.equal((await call('crm-unattended', { botId: 'b2', mode: 'read' }, LUIS)).error.code, 'bot/not-found')
  assert.equal((await call('crm-unattended', { botId: 'b4', mode: 'read' }, ANA)).error.code, 'bot/forbidden')
  const view = (await call('crm-unattended', { botId: 'b2', mode: 'read' })).value
  assert.equal(view.bots.find(bot => bot.id === 'b2').unattended, 'read')
  assert.match(await tool('crm_list_accounts', {}, 'b2'), /act for your owner, Ana García, with reading only/)
  await tool('crm_search_leads', { account: `sla:${PA1}:${WS1}` }, 'b2')
  // Reading only: a change is refused before the CRM sees it, even on an operator account.
  const before = crmCalls.length
  await assert.rejects(tool('crm_create_lead', { account: `sla:${PA1}:${WS1}`, name: 'Eva', phone: '525511112222' }, 'b2'), /may only read in the CRM in turns no person started/)
  assert.equal(crmCalls.length, before)
})

test('the person who answered a question card is the one the next turn acts for', async (t) => {
  const { call, rt, turn, tool, stop } = start()
  t.after(stop)
  await call('state')
  rt.state.questions.b1 = { id: 'q1', question: 'Which account?', options: [{ label: 'Uno' }], askedAt: 1 }
  const answered = await call('answer-question', { sessionId: 'b1', questionId: 'q1', answer: { selected: ['Uno'] } })
  assert.equal(answered.ok, true, JSON.stringify(answered))
  turn('b1', { kind: REPLY_KIND, callId: 'c1', outcome: 'answered' })
  assert.match(await tool('crm_list_accounts', {}, 'b1'), /Acting for Ana García/)
})

test('a message nobody claimed, an expired session or lost access refuses the call', async (t) => {
  const { call, rt, turn, asked, tool, stop } = start()
  t.after(stop)
  await call('state')
  turn('b1', { kind: 'user', rpcId: 'rpc-unclaimed-test' })
  await assert.rejects(tool('crm_list_accounts'), /could not tell who sent the message/)
  // Luis edits b1 and asked, but his last request carried an expired token.
  await asked('b1', LUIS, testJwt({ exp: NOW() - 10 }))
  await assert.rejects(tool('crm_list_accounts'), /Atenea session of Luis has expired/)
  // Ana asked, then lost her access to the Bot.
  await asked('b1', ANA)
  await call('state', {}, { ...ANA, agents: {} })
  await assert.rejects(tool('crm_list_accounts'), /may not work with Seller any more/)
  assert.equal(rt.teamTools.length > 0, true)
})

test('in a group round the one person who wrote is acted for; two people make it unclear', async (t) => {
  const { call, rt, tool, stop } = start()
  t.after(stop)
  await call('state')
  await call('state', {}, LUIS)
  const room = rt.state.rooms.r1
  room.log.push({ seq: 1, who: 'User', author: 'Ana García', authorId: 'u-ana', text: 'check leads' })
  room.seq = 1
  rt.roomProgress.set('round-call', { roomId: 'r1', startSeq: 1, slots: [], replies: [] })
  assert.match(await tool('crm_list_accounts', {}, 'g4'), /Acting for Ana García/)
  room.log.push({ seq: 2, who: 'User', author: 'Luis', authorId: 'u-luis', text: 'and send' })
  await assert.rejects(tool('crm_list_accounts', {}, 'g4'), /Several people wrote in this round/)
  rt.roomProgress.delete('round-call')
  await assert.rejects(tool('crm_list_accounts', {}, 'g4'), /No person started this turn/)
})

// ---------------------------------------------------------------------------
// Staff grants

test('a grant is asked once per account and mode, kept until it nears its end, and renewed after', async (t) => {
  let life = 15 * 60_000
  const { call, asked, tool, slaCalls, crmCalls, stop } = start({
    sla: entry => (entry.path === '/api/atenea/grants' ? json({ grant: `test-grant-${slaCalls.length}`, expiresAt: new Date(Date.now() + life).toISOString() }, 201) : undefined),
  })
  t.after(stop)
  await call('state')
  await asked()
  await tool('crm_search_leads', { account: `sla:${PA1}:${WS1}`, search: 'ana' })
  await tool('crm_get_lead', { account: 'Cliente Uno', lead_id: LEAD1 })
  const grantCalls = () => slaCalls.filter(entry => entry.path === '/api/atenea/grants')
  assert.equal(grantCalls().length, 1)
  assert.deepEqual(grantCalls()[0].body, { productAccountId: PA1, workspaceId: WS1, mode: 'read', reason: 'Atenea: Seller for Ana García (crm_search_leads)' })
  assert.equal(crmCalls[0].headers.Authorization, crmCalls[1].headers.Authorization)
  assert.match(crmCalls[0].headers.Authorization, /^Bearer test-grant-/)
  assert.equal(crmCalls[0].query.subaccountId, SUB1)
  assert.equal(crmCalls[0].query.search, 'ana')
  // A write asks for an operate grant of its own.
  await tool('crm_create_lead', { account: `sla:${PA1}:${WS1}`, name: 'Eva', phone: '525511112222' })
  assert.deepEqual(grantCalls().map(entry => entry.body.mode), ['read', 'operate'])
  // A grant with less than the margin left is not reused.
  life = 30_000
  await tool('crm_search_leads', { account: `sla:${PA2}:${WS2}` })
  await tool('crm_search_leads', { account: `sla:${PA2}:${WS2}` })
  assert.equal(grantCalls().filter(entry => entry.body.productAccountId === PA2).length, 2)
})

test('a grant the CRM calls expired is replaced once, and SLA\'s refusals are explained', async (t) => {
  let refusedOnce = false
  const { call, asked, tool, slaCalls, stop } = start({
    crm: (entry) => {
      if (entry.path === '/api/contacts/v1' && !refusedOnce) {
        refusedOnce = true
        return json({ error: 'La concesión ha caducado' }, 401)
      }
      return undefined
    },
    sla: entry => (entry.path === '/api/atenea/grants' && entry.body.productAccountId === PA2 && entry.body.mode === 'operate' ? json({ error: 'insufficient_access_level' }, 403) : undefined),
  })
  t.after(stop)
  await call('state')
  await asked()
  await tool('crm_search_leads', { account: `sla:${PA1}:${WS1}` })
  assert.equal(slaCalls.filter(entry => entry.path === '/api/atenea/grants').length, 2)
  assert.equal(crmFailureText({ status: 403, said: 'insufficient' }, { via: 'own' }), 'The CRM refused: your CRM user may not do this in that account: insufficient.')
})

test('a change in read mode is refused before SLA or the CRM is asked', async (t) => {
  const { call, asked, tool, slaCalls, crmCalls, audits, settle, stop } = start()
  t.after(stop)
  await call('state')
  await asked()
  const grantsBefore = slaCalls.filter(entry => entry.path === '/api/atenea/grants').length
  for (const [name, args] of [
    ['crm_create_lead', { name: 'Eva', email: 'eva@lead.example' }],
    ['crm_send_message', { conversation_id: CONV, text: 'hola' }],
    ['crm_move_stage', { lead_id: LEAD1, stage: 'WON' }],
    ['crm_import_leads', { file: 'leads.csv' }],
    ['crm_start_conversation', { lead_ids: [LEAD1], channel_id: CHANNEL, template_id: TEMPLATE }],
  ]) {
    await assert.rejects(tool(name, { account: `sla:${PA2}:${WS2}`, ...args }), /Ana García can only read in Cliente Dos/, name)
  }
  assert.equal(crmCalls.length, 0)
  assert.equal(slaCalls.filter(entry => entry.path === '/api/atenea/grants').length, grantsBefore)
  await settle()
  assert.ok(audits().filter(entry => entry.detail.outcome === 'refused').length >= 5)
})

test('the CRM\'s refusals of a staff grant, and its author limit, come back in plain words', async (t) => {
  const { call, asked, tool, work, stop } = start({
    crm: (entry) => {
      if (entry.path === '/api/contacts/v1/imports' && entry.method === 'POST') return json({ error: 'failed to create import job' }, 500)
      if (entry.path === '/api/contacts/v1' && entry.method === 'POST') return json({ error: 'Esta concesión es de solo lectura' }, 403)
      if (entry.path.startsWith('/api/contacts/v1/') && entry.method === 'GET') return json({ error: 'Esta acción no está disponible con una concesión de Atenea' }, 403)
      return undefined
    },
  })
  t.after(stop)
  writeFileSync(join(work, 'leads.csv'), 'Nombre,Telefono\nEva,525511112222\n')
  await call('state')
  await asked()
  await assert.rejects(tool('crm_import_leads', { account: `sla:${PA1}:${WS1}`, file: 'leads.csv' }), /records who made it, and it cannot record a staff member yet/)
  await assert.rejects(tool('crm_create_lead', { account: `sla:${PA1}:${WS1}`, name: 'Eva', phone: '525511112222' }), /staff grant only allows reading/)
  await assert.rejects(tool('crm_get_lead', { account: `sla:${PA1}:${WS1}`, lead_id: LEAD1 }), /keeps this action for the account's own users/)
  assert.match(crmFailureText({ status: 403, said: 'Esta concesión no cubre esa subcuenta' }, { via: 'grant' }), /another subaccount/)
})

test('a staff grant does not send messages: the CRM would deliver before failing to record the sender', async (t) => {
  const { call, asked, tool, crmCalls, stop } = start()
  t.after(stop)
  await call('state')
  await asked()
  await assert.rejects(tool('crm_send_message', { account: `sla:${PA1}:${WS1}`, conversation_id: CONV, text: 'hola' }), /A staff grant cannot send messages yet/)
  await assert.rejects(tool('crm_start_conversation', { account: `sla:${PA1}:${WS1}`, lead_ids: [LEAD1], channel_id: CHANNEL, template_id: TEMPLATE }), /A staff grant cannot send messages yet/)
  assert.equal(crmCalls.filter(entry => entry.method === 'POST').length, 0)
})

test('with ATENEA_CRM_STAFF_AUTHORS a staff grant sends', async (t) => {
  const { call, asked, tool, crmCalls, stop } = start({
    config: { staffAuthors: true },
    crm: entry => (entry.path.endsWith('/messages') && entry.method === 'POST' ? json({ messageId: 'm1', status: 'SENT' }) : undefined),
  })
  t.after(stop)
  await call('state')
  await asked()
  assert.match(await tool('crm_send_message', { account: `sla:${PA1}:${WS1}`, conversation_id: CONV, text: 'hola' }), /Sent \(message m1, SENT\)/)
  assert.deepEqual(crmCalls.at(-1).body, { body: 'hola' })
})

// ---------------------------------------------------------------------------
// The person's own CRM user

test('linking uses PKCE and a one-time state bound to the person who started it', async (t) => {
  const { call, callback, crmCalls, home, audits, settle, stop } = start()
  t.after(stop)
  const started = (await call('crm-link-start')).value
  const url = new URL(started.url)
  assert.equal(url.origin + url.pathname, `${LOGIN}/oauth2/authorize`)
  assert.equal(url.searchParams.get('client_id'), CLIENT)
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('response_type'), 'code')
  const state = url.searchParams.get('state')
  assert.ok(state.length >= 32)
  // Another person, no identity, or a made-up state do not complete it.
  assert.equal((await callback({ state, code: 'test-code' }, LUIS)).status, 403)
  const again = new URL((await call('crm-link-start')).value.url).searchParams
  assert.equal((await callback({ state: again.get('state'), code: 'test-code' }, null)).status, 401)
  assert.equal((await callback({ state: 'made-up-state', code: 'test-code' })).status, 400)
  const page = await callback({ state: again.get('state'), code: 'test-code' })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Your CRM account is linked/)
  const exchange = crmCalls.find(entry => entry.body?.grant_type === 'authorization_code')
  assert.equal(exchange.body.code, 'test-code')
  assert.equal(exchange.body.redirect_uri, REDIRECT)
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), again.get('code_challenge'))
  // The state works once.
  assert.equal((await callback({ state: again.get('state'), code: 'test-code' })).status, 400)
  // Sealed at rest, readable only by the server user.
  const path = join(home, 'crm-links.json')
  const saved = readFileSync(path, 'utf8')
  assert.doesNotMatch(saved, /test-refresh-token|ana@client/)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  const view = (await call('crm-view')).value
  assert.equal(view.link.linked, true)
  assert.equal(view.link.email, 'ana@client.example')
  assert.deepEqual(view.accounts.find(account => account.via === 'own'), { ref: `own:${OWN_SUB}`, via: 'own', name: 'Mi Sucursal', level: 'operate', subaccountId: OWN_SUB })
  await settle()
  assert.ok(audits().some(entry => entry.action === 'crm.link' && entry.targetId === 'crm-user-1'))
})

test('an own account call uses the person\'s ID token, renewed from the sealed refresh token', async (t) => {
  const { call, callback, asked, tool, crmCalls, rt, stop } = start()
  t.after(stop)
  const state = new URL((await call('crm-link-start')).value.url).searchParams.get('state')
  await callback({ state, code: 'test-code' })
  await asked()
  await tool('crm_search_leads', { account: `own:${OWN_SUB}` })
  const search = crmCalls.find(entry => entry.path === '/api/contacts/v1')
  assert.match(search.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.test-signature$/)
  assert.equal(crmCalls.filter(entry => entry.body?.grant_type === 'refresh_token').length, 0)
  // After a restart only the sealed refresh token is left.
  const reborn = start({ state: rt.state })
  t.after(reborn.stop)
  writeFileSync(join(reborn.home, 'crm-links.json'), readFileSync(join(rt.home, 'crm-links.json')))
  await reborn.call('state')
  await reborn.asked()
  await reborn.tool('crm_search_leads', { account: `own:${OWN_SUB}` })
  const refresh = reborn.crmCalls.find(entry => entry.body?.grant_type === 'refresh_token')
  assert.equal(refresh.body.refresh_token, 'test-refresh-token')
  assert.equal(refresh.body.client_id, CLIENT)
})

test('unlinking revokes the refresh token, and one the CRM sign-in refuses unlinks the account', async (t) => {
  const first = start()
  t.after(first.stop)
  const state = new URL((await first.call('crm-link-start')).value.url).searchParams.get('state')
  await first.callback({ state, code: 'test-code' })
  const view = (await first.call('crm-unlink')).value
  assert.equal(view.link.linked, false)
  await first.settle()
  assert.equal(first.crmCalls.find(entry => entry.path === '/oauth2/revoke').body.token, 'test-refresh-token')
  const relink = new URL((await first.call('crm-link-start')).value.url).searchParams.get('state')
  await first.callback({ state: relink, code: 'test-code' })

  const second = start({ crm: entry => (entry.body?.grant_type === 'refresh_token' ? json({ error: 'invalid_grant' }, 400) : undefined) })
  t.after(second.stop)
  writeFileSync(join(second.home, 'crm-links.json'), readFileSync(join(first.home, 'crm-links.json')))
  await second.call('state')
  await second.asked()
  await assert.rejects(second.tool('crm_search_leads', { account: `own:${OWN_SUB}` }), /Could not read: Your CRM account: Your CRM sign-in expired or was revoked/)
  assert.equal((await second.call('crm-view')).value.link.linked, false)
})

test('linking that is not set up says what is missing', async (t) => {
  const { call, stop } = start({ config: { cognitoDomain: undefined, tokenKey: 'short' } })
  t.after(stop)
  const view = (await call('crm-view')).value
  assert.equal(view.link.ready, false)
  assert.match(view.link.gap, /ATENEA_CRM_COGNITO_DOMAIN/)
  assert.match(view.link.gap, /ATENEA_CRM_TOKEN_KEY must be 32 random bytes/)
  assert.match((await call('crm-link-start')).error.message, /Linking your own CRM account is not set up/)
})

test('an SLA token is offered until shortly before it expires', async (t) => {
  assert.equal(tokenExpiry(testJwt({ exp: 1000 })), 1_000_000)
  assert.equal(tokenExpiry('not-a-jwt'), undefined)
  const { call, rt, stop } = start()
  t.after(stop)
  await call('state', {}, ANA, testJwt({ exp: NOW() + 20 }))
  assert.equal(rt.keptContext('u-ana').expired, true)
  await call('state', {}, ANA, testJwt({ exp: NOW() + 600 }))
  assert.equal(rt.keptContext('u-ana').identity.name, 'Ana García')
  assert.equal(rt.keptContext('u-nobody'), undefined)
})

test('sealed tokens open only with the same key and staff id', () => {
  const key = parseTokenKey(TOKEN_KEY)
  const sealed = seal(key, 'u-ana', { refreshToken: 'test-refresh-token' })
  assert.deepEqual(unseal(key, 'u-ana', sealed), { refreshToken: 'test-refresh-token' })
  assert.throws(() => unseal(key, 'u-luis', sealed))
  assert.throws(() => unseal(parseTokenKey('ab'.repeat(32)), 'u-ana', sealed))
  assert.throws(() => unseal(key, 'u-ana', { ...sealed, data: Buffer.from('tampered').toString('base64') }))
  assert.equal(parseTokenKey(''), undefined)
  assert.equal(parseTokenKey('0f'.repeat(32)).length, 32)
  assert.equal(parseTokenKey(Buffer.alloc(32, 1).toString('base64url')).length, 32)
  assert.throws(() => parseTokenKey('too-short'), /32 random bytes/)
})

test('the link store reads back what it sealed, and nothing under another key', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-crm-links-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const store = createLinkStore({ path: join(home, 'links.json'), key: parseTokenKey(TOKEN_KEY) })
  await store.write('u-ana', { refreshToken: 'test-a' })
  assert.equal(store.read('u-ana').refreshToken, 'test-a')
  const fresh = createLinkStore({ path: join(home, 'links.json'), key: parseTokenKey(TOKEN_KEY) })
  assert.equal(fresh.read('u-ana').refreshToken, 'test-a')
  assert.equal(createLinkStore({ path: join(home, 'links.json'), key: parseTokenKey('ab'.repeat(32)) }).read('u-ana'), undefined)
  assert.equal(await fresh.remove('u-ana'), true)
  assert.equal(await fresh.remove('u-ana'), false)
})

test('PKCE pairs and ID token checks follow the specs', () => {
  const { verifier, challenge } = pkcePair()
  assert.match(verifier, /^[\w-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.notEqual(pkcePair().verifier, verifier)
  const url = new URL(authorizeUrl({ domain: `${LOGIN}/`, clientId: CLIENT, redirectUri: REDIRECT }, { state: 's', challenge }))
  assert.equal(url.pathname, '/oauth2/authorize')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  const settings = { userPoolId: POOL, region: 'mx-central-1', clientId: CLIENT }
  const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
  assert.equal(idTokenProblem(claims(crmIdToken()), settings), undefined)
  assert.equal(idTokenProblem(claims(crmIdToken({ aud: 'other' })), settings), 'ID token for another client')
  assert.equal(idTokenProblem(claims(crmIdToken({ token_use: 'access' })), settings), 'not an ID token')
  assert.equal(idTokenProblem(claims(crmIdToken({ iss: 'https://cognito-idp.mx-central-1.amazonaws.com/other' })), settings), 'ID token from another pool')
  assert.equal(idTokenProblem(claims(crmIdToken({ exp: NOW() - 1 })), settings), 'expired ID token')
})

// ---------------------------------------------------------------------------
// Arguments, audit, the write limit and bulk sends

test('arguments are checked before anything leaves the host', async (t) => {
  const { call, asked, tool, crmCalls, slaCalls, stop } = start()
  t.after(stop)
  await call('state')
  await asked()
  const grantsBefore = slaCalls.filter(entry => entry.path === '/api/atenea/grants').length
  await assert.rejects(tool('crm_get_lead', { account: `sla:${PA1}:${WS1}`, lead_id: 'Eva' }), /lead_id must be a CRM id/)
  await assert.rejects(tool('crm_create_lead', { account: `sla:${PA1}:${WS1}`, name: 'Eva' }), /needs an e-mail address or a phone number/)
  await assert.rejects(tool('crm_create_lead', { account: `sla:${PA1}:${WS1}`, name: 'Eva', phone: '12' }), /phone must be 6 to 15 digits/)
  await assert.rejects(tool('crm_search_leads', { account: `sla:${PA1}:${WS1}`, limit: 500 }), /limit must be a whole number from 1 to 50/)
  await assert.rejects(tool('crm_import_leads', { account: `sla:${PA1}:${WS1}` }), /Give either file/)
  await assert.rejects(tool('crm_import_leads', { account: `sla:${PA1}:${WS1}`, file: 'leads.pdf' }), /imports .csv or .xlsx/)
  await assert.rejects(tool('crm_start_conversation', { account: `sla:${PA1}:${WS1}`, channel_id: CHANNEL }), /both channel_id and template_id/)
  await assert.rejects(tool('crm_send_message', { account: `sla:${PA1}:${WS1}`, conversation_id: CONV, text: 'x'.repeat(5000) }), /at most 4096/)
  await assert.rejects(tool('crm_search_leads', { account: 'Nobody' }), /No CRM account "Nobody"/)
  assert.equal(crmCalls.length, 0)
  assert.equal(slaCalls.filter(entry => entry.path === '/api/atenea/grants').length, grantsBefore)
  assert.equal(textArg('  x ', 'a'), 'x')
  assert.equal(idArg(undefined, 'a', { required: false }), undefined)
  assert.equal(wholeArg('7', 'a', { min: 1, max: 9, fallback: 1 }), 7)
  assert.deepEqual(idListArg(`${LEAD1}, ${LEAD2},${LEAD1}`, 'lead_ids', { max: 5 }), [LEAD1, LEAD2])
  assert.throws(() => idListArg([LEAD1, LEAD2], 'lead_ids', { max: 1 }), /at most 1/)
})

test('a workspace file outside the Bot\'s folder is not imported', async (t) => {
  const { call, callback, asked, tool, home, crmCalls, stop } = start()
  t.after(stop)
  writeFileSync(join(home, 'secret.csv'), 'Nombre\nX\n')
  const state = new URL((await call('crm-link-start')).value.url).searchParams.get('state')
  await callback({ state, code: 'test-code' })
  await asked()
  await assert.rejects(tool('crm_import_leads', { account: `own:${OWN_SUB}`, file: '../secret.csv' }), /outside your working folder/)
  await assert.rejects(tool('crm_import_leads', { account: `own:${OWN_SUB}`, file: 'missing.csv' }), /There is no file/)
  assert.equal(crmCalls.filter(entry => entry.path.startsWith('/api/contacts')).length, 0)
})

test('an import uploads the file and follows the job until it ends', async (t) => {
  let polls = 0
  const { call, callback, asked, tool, work, crmCalls, stop } = start({
    crm: (entry) => {
      if (entry.path === '/api/contacts/v1/imports') return json({ id: LEAD2, status: 'PENDING' }, 202)
      if (entry.path === `/api/contacts/v1/imports/${LEAD2}`) return json(++polls < 2 ? { id: LEAD2, status: 'PROCESSING' } : { id: LEAD2, status: 'COMPLETED', totalRows: 2, processedRows: 2, successCount: 1, duplicateCount: 1, errorCount: 0 })
      return undefined
    },
  })
  t.after(stop)
  writeFileSync(join(work, 'leads.csv'), 'Nombre,Telefono\nEva,525511112222\nEva,525511112222\n')
  const state = new URL((await call('crm-link-start')).value.url).searchParams.get('state')
  await callback({ state, code: 'test-code' })
  await asked()
  const text = await tool('crm_import_leads', { account: `own:${OWN_SUB}`, file: 'leads.csv' })
  assert.match(text, /COMPLETED, rows 2\/2: 1 added, 1 duplicates, 0 rejected/)
  const upload = crmCalls.find(entry => entry.path === '/api/contacts/v1/imports')
  assert.ok(upload.rawBody instanceof FormData)
  assert.equal(upload.rawBody.get('subaccountId'), OWN_SUB)
  assert.equal(upload.rawBody.get('file').name, 'leads.csv')
})

test('every call is audited with ids and counts only, never a message or contact data', async (t) => {
  const { call, callback, asked, tool, audits, settle, slaToken, slaCalls, stop } = start({
    crm: (entry) => {
      if (entry.path === '/api/contacts/v1' && entry.method === 'GET') return json({ data: [{ id: LEAD1, name: 'Eva', phone: '525511112222', email: 'eva@lead.example' }], total: 1 })
      if (entry.path.endsWith('/messages') && entry.method === 'POST') return json({ messageId: 'm1', status: 'SENT' })
      return undefined
    },
  })
  t.after(stop)
  const state = new URL((await call('crm-link-start')).value.url).searchParams.get('state')
  await callback({ state, code: 'test-code' })
  await asked()
  const found = JSON.parse(await tool('crm_search_leads', { account: `own:${OWN_SUB}` }))
  assert.equal(found.leads[0].phone, '525511112222')
  await tool('crm_send_message', { account: `own:${OWN_SUB}`, conversation_id: CONV, text: 'Hola Eva, te escribo por tu cotización' })
  await settle()
  const lines = audits()
  const search = lines.find(entry => entry.action === 'crm.search_leads')
  assert.deepEqual(search, { action: 'crm.search_leads', targetType: 'crm_subaccount', targetId: OWN_SUB, detail: { botId: 'b1', how: 'asked', via: 'own', mode: 'operate', outcome: 'ok', count: 1 } })
  const send = lines.find(entry => entry.action === 'crm.send_message')
  assert.deepEqual(send.detail, { botId: 'b1', how: 'asked', via: 'own', mode: 'operate', outcome: 'ok', conversationId: CONV, length: 38, status: 'SENT' })
  const written = JSON.stringify(lines)
  assert.doesNotMatch(written, /Eva|525511112222|eva@lead|cotización/)
  // Audit lines go to SLA as the person, with their own token.
  assert.ok(slaCalls.filter(entry => entry.path === '/api/atenea/audit').every(entry => entry.auth === `Bearer ${slaToken}`))
})

test('changes are limited per person and minute', async (t) => {
  const { call, callback, asked, tool, stop } = start({
    config: { writesPerMinute: 2 },
    crm: entry => (entry.path === '/api/contacts/v1' && entry.method === 'POST' ? json({ id: LEAD1 }, 201) : undefined),
  })
  t.after(stop)
  const state = new URL((await call('crm-link-start')).value.url).searchParams.get('state')
  await callback({ state, code: 'test-code' })
  await asked()
  const create = () => tool('crm_create_lead', { account: `own:${OWN_SUB}`, name: 'Eva', phone: '525511112222' })
  await create()
  await create()
  await assert.rejects(create(), /made 2 CRM changes in the last minute, and the limit is 2 a minute/)
  await assert.rejects(tool('crm_start_conversation', { account: `own:${OWN_SUB}`, lead_ids: [LEAD1, LEAD2, CONV], channel_id: CHANNEL, template_id: TEMPLATE }), /at most 2 in one call/)
})

const TEMPLATES = [{ name: 'saludo', status: 'APPROVED', channels: [{ id: TEMPLATE, channelId: 'wa', providerStatus: 'APPROVED' }] }]
function sendsCrm(entry) {
  if (entry.path === '/api/templates/v1') return json(TEMPLATES)
  if (entry.path === `/api/subaccounts/v1/${OWN_SUB}`) return json({ id: OWN_SUB, channels: [{ id: CHANNEL, channelId: 'wa', status: 'ACTIVE', isActive: true, wabaConfig: { accessToken: 'test-should-not-leak' } }] })
  if (entry.path === '/api/conversations/v1/send-template') return json({ conversationId: CONV, messageId: 'm1', status: 'SENT' })
  return undefined
}
async function linked(options) {
  const run = start({ crm: sendsCrm, ...options })
  const state = new URL((await run.call('crm-link-start')).value.url).searchParams.get('state')
  await run.callback({ state, code: 'test-code' })
  return run
}

test('a send to several leads waits for the person\'s confirmation; a refusal sends nothing', async (t) => {
  const approval = fakeApproval('rejected')
  const run = await linked({ approval })
  t.after(run.stop)
  await run.asked()
  const args = { account: `own:${OWN_SUB}`, lead_ids: [LEAD1, LEAD2], channel_id: CHANNEL, template_id: TEMPLATE }
  await assert.rejects(run.tool('crm_start_conversation', args), /was not confirmed, so nothing was sent/)
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /Send the template "saludo" to 2 leads in Mi Sucursal, as Ana García/)
  assert.equal(approval.requests[0].toolName, 'crm_start_conversation')
  assert.equal(run.crmCalls.filter(entry => entry.path === '/api/conversations/v1/send-template').length, 0)
})

test('a confirmed send messages each lead once, with an idempotency key, and a repeat sends nothing', async (t) => {
  const approval = fakeApproval('allowed-once')
  const run = await linked({ approval })
  t.after(run.stop)
  await run.asked()
  const args = { account: `own:${OWN_SUB}`, lead_ids: [LEAD1, LEAD2], channel_id: CHANNEL, template_id: TEMPLATE, request_id: 'promo-1' }
  const text = await run.tool('crm_start_conversation', args)
  assert.match(text, /2 of 2 sent/)
  const sends = run.crmCalls.filter(entry => entry.path === '/api/conversations/v1/send-template')
  assert.deepEqual(sends.map(entry => entry.body.contactId), [LEAD1, LEAD2])
  assert.deepEqual(sends[0].body, { subaccountChannelId: CHANNEL, messageTemplateChannelId: TEMPLATE, contactId: LEAD1, subaccountId: OWN_SUB })
  assert.match(sends[0].headers['Idempotency-Key'], /^[0-9a-f]{40}$/)
  assert.notEqual(sends[0].headers['Idempotency-Key'], sends[1].headers['Idempotency-Key'])
  assert.match(await run.tool('crm_start_conversation', args), /sent before; not sent again/)
  assert.equal(run.crmCalls.filter(entry => entry.path === '/api/conversations/v1/send-template').length, 2)
  // One lead needs no confirmation.
  await run.tool('crm_start_conversation', { ...args, lead_ids: [LEAD1], request_id: 'promo-2' })
  assert.equal(approval.requests.length, 2)
})

test('a send to several leads in a turn no person started is refused', async (t) => {
  const run = await linked({ approval: fakeApproval('allowed-once') })
  t.after(run.stop)
  await run.call('crm-unattended', { botId: 'b2', mode: 'operate' })
  run.turn('b2', { kind: 'schedule' })
  await assert.rejects(run.tool('crm_start_conversation', { account: `own:${OWN_SUB}`, lead_ids: [LEAD1, LEAD2], channel_id: CHANNEL, template_id: TEMPLATE }, 'b2'), /needs a person to confirm it, and no person started this turn/)
  assert.equal(run.crmCalls.filter(entry => entry.path === '/api/conversations/v1/send-template').length, 0)
})

test('without channel and template the account\'s channels and templates are listed, without channel secrets', async (t) => {
  const run = await linked()
  t.after(run.stop)
  await run.asked()
  const listed = JSON.parse(await run.tool('crm_start_conversation', { account: `own:${OWN_SUB}` }))
  assert.deepEqual(listed.channels, [{ id: CHANNEL, channelId: 'wa', status: 'ACTIVE', active: true }])
  assert.deepEqual(listed.templates, [{ name: 'saludo', status: 'APPROVED', channels: [{ template_id: TEMPLATE, channelId: 'wa', providerStatus: 'APPROVED' }] }])
  assert.equal(run.crmCalls.filter(entry => entry.method === 'POST' && entry.host === CRM).length, 0)
})

test('a stage is found by key or name before the lead moves', async (t) => {
  const run = await linked({
    crm: (entry) => {
      if (entry.path === '/api/pipeline/v1/stages') return json([{ id: STAGE, key: 'WON', label: 'Ganado' }])
      if (entry.path === `/api/pipeline/v1/leads/${LEAD1}/stage`) return json(null, 204)
      return undefined
    },
  })
  t.after(run.stop)
  await run.asked()
  assert.match(await run.tool('crm_move_stage', { account: `own:${OWN_SUB}`, lead_id: LEAD1, stage: 'ganado' }), /Moved lead .* to "Ganado"/)
  assert.deepEqual(run.crmCalls.at(-1).body, { subaccountId: OWN_SUB, stageId: STAGE })
  assert.equal(run.crmCalls.at(-1).method, 'PUT')
  await assert.rejects(run.tool('crm_move_stage', { account: `own:${OWN_SUB}`, lead_id: LEAD1, stage: 'LOST' }), /No stage "LOST".*Ganado \(WON\)/)
})

test('the CRM card answers each person with their own link, accounts and Bots', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const view = (await call('crm-view')).value
  assert.equal(view.link.ready, true)
  assert.equal(view.link.linked, false)
  assert.deepEqual(view.accounts.map(account => [account.ref, account.level]), [[`sla:${PA1}:${WS1}`, 'operate'], [`sla:${PA2}:${WS2}`, 'read']])
  assert.deepEqual(view.bots.map(bot => bot.id), ['b1', 'b2'])
  assert.equal((await call('crm-view', {}, LUIS)).value.bots.map(bot => bot.id).join(), 'b4')
  assert.equal((await call('crm-unattended', { botId: 'b2', mode: 'everything' })).error.code, 'bot/invalid')
})
