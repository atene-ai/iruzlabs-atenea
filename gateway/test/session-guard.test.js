import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ALLOWED_NAMESPACES, DENIED_ENDPOINTS } from '../src/policy.js'
import { ACCESS_TTL_MS, accessPrint } from '../src/session-access.js'
import { DENIED_STREAM_ENDPOINT, GUARD_BODY_LIMIT } from '../src/session-guard.js'
import { ROUTE_RULES, RULES, RuleError, sessionReferences, sessionsOf } from '../src/session-rules.js'
import { createFrameReader, FrameError, maskedFrame } from '../src/websocket.js'
import { clientFrame, closed, openWebSocket, PUBLIC_URL, signIn, startEnv } from './helpers.js'

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/dsh-remotes.json', import.meta.url), 'utf8'))
const namespaceOf = endpoint => endpoint.split('/')[0]
const reference = id => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`

// ---------------------------------------------------------------------------
// The rule table against dsh's Remote endpoints

function checkCoverage(endpoints) {
  const allowed = Object.keys(endpoints).filter(endpoint => ALLOWED_NAMESPACES.has(namespaceOf(endpoint)))
  assert.deepEqual(allowed.filter(endpoint => !Object.hasOwn(RULES, endpoint)), [], 'methods of an allowed namespace without a rule')
  return allowed
}

test('every method of every namespace the path policy lets through has a session rule', () => {
  assert.deepEqual(SNAPSHOT.versions, ['0.2.0-rc.2', '0.2.1-rc.5'])
  const allowed = checkCoverage(SNAPSHOT.endpoints)
  assert.ok(allowed.length >= 70, `found ${allowed.length}`)
  for (const namespace of ALLOWED_NAMESPACES) assert.ok(allowed.some(endpoint => namespaceOf(endpoint) === namespace), `${namespace} has no methods in dsh`)
})

test('every rule names a dsh method, with its mode and the arguments it reads', () => {
  for (const [endpoint, rule] of Object.entries(RULES)) {
    if (endpoint === '$events') {
      assert.equal(rule.stream, true)
      continue
    }
    const known = SNAPSHOT.endpoints[endpoint]
    assert.ok(known, `${endpoint} is not a dsh method`)
    assert.equal(rule.stream === true, known.stream, `${endpoint} stream`)
    assert.ok(['open', 'read', 'write', 'superadmin'].includes(rule.need), endpoint)
    if (rule.need === 'read' || rule.need === 'write') assert.ok(rule.paths.length > 0, `${endpoint} names no Session`)
    for (const path of rule.paths ?? []) {
      const [arg, field] = path.split('.')
      assert.ok(Object.hasOwn(known.args, arg), `${endpoint}: no argument ${arg}`)
      if (field !== undefined) assert.ok(known.args[arg].includes(field), `${endpoint}: ${arg} has no field ${field}`)
    }
  }
})

// The DSH packages the ds-bot tests install, when they are there: the same check on
// whatever version they are.
const installed = [process.env.DSH_HARNESS && join(process.env.DSH_HARNESS, 'node_modules', '@deepseek-ai'), new URL('../../ds-bot/dev/harness/node_modules/@deepseek-ai', import.meta.url).pathname]
  .find(dir => dir && existsSync(join(dir, 'dsh', 'package.json')))

test('the installed DSH has no method in an allowed namespace without a rule', { skip: installed === undefined && 'no DSH install found' }, () => {
  const script = new URL('../scripts/dsh-remotes.mjs', import.meta.url).pathname
  const listed = JSON.parse(execFileSync(process.execPath, [script, installed], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  checkCoverage(listed.endpoints)
})

test('a rule finds its Sessions where dsh reads them, and refuses a call that hides one', () => {
  assert.deepEqual(sessionsOf(RULES['session/prompt'], { request: { sessionId: 's1', content: [] } }), ['s1'])
  assert.deepEqual(sessionsOf(RULES['goals/get'], { agentId: 's1' }), ['s1'])
  assert.deepEqual(sessionsOf(RULES['subagents/prompt'], { request: { parentSessionId: 'p', childSessionId: 'c' } }), ['p', 'c'])
  assert.deepEqual(sessionsOf(RULES['subagents/interruptByParent'], { childSessionId: 'c', parentSessionId: 'p', mode: 'continuable' }), ['c', 'p'])
  assert.deepEqual(sessionsOf(RULES['session/page'], { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 3 } }), ['s1'])
  assert.deepEqual(sessionsOf(RULES['session/follow'], { request: { address: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'unknown' } } }), ['p', 'c'])
  for (const args of [
    {},
    { request: {} },
    { request: { sessionId: '' } },
    { request: { sessionId: 7 } },
    { request: ['s1'] },
    // An inherited field is not dsh's field.
    JSON.parse('{"request":{"__proto__":{"sessionId":"s1"}}}'),
    Object.create({ request: { sessionId: 's1' } }),
  ]) {
    assert.throws(() => sessionsOf(RULES['session/prompt'], args), RuleError, JSON.stringify(args))
  }
  for (const address of [undefined, 's1', { kind: 'session' }, { kind: 'subagent', parentSessionId: 'p' }, { kind: 'other', sessionId: 's1' }]) {
    assert.throws(() => sessionsOf(RULES['session/page'], { request: { address } }), RuleError, JSON.stringify(address))
  }
})

test('a Session mentioned anywhere in a payload is found, and one that does not decode is refused', () => {
  const payload = {
    request: {
      content: [
        { type: 'text', text: `look at @[Plan](${reference('sess-c')}) and ${reference('sess-b')}.` },
        { type: 'image', data: 'AAAA' },
      ],
    },
    [`key ${reference('sess-k')}`]: true,
  }
  assert.deepEqual(sessionReferences(payload), { ids: ['sess-c', 'sess-b', 'sess-k'], unreadable: false })
  assert.deepEqual(sessionReferences({ text: 'nothing here', n: 3, list: ['a'] }), { ids: [], unreadable: false })
  assert.equal(sessionReferences({ text: 'dsh-session:@@' }).unreadable, true)
  assert.equal(sessionReferences({ text: 'dsh-session:' }).unreadable, true)
  // Not canonical: the same id with padding, and an id that is not a string.
  assert.equal(sessionReferences({ text: `${reference('x')}=` }).ids.length, 1)
  assert.equal(sessionReferences({ text: `dsh-session:${Buffer.from('7').toString('base64url')}` }).unreadable, true)
  let deep = { text: reference('deep') }
  for (let index = 0; index < 70; index += 1) deep = { deep }
  assert.equal(sessionReferences(deep).unreadable, true)
})

test('a person\'s cache bucket changes with their grants', () => {
  const ana = { id: 'staff-1', role: 'support', agents: { 'bot-a': 'owner', 'bot-b': 'reader' } }
  assert.equal(accessPrint(ana), accessPrint({ ...ana, agents: { 'bot-b': 'reader', 'bot-a': 'owner' } }))
  assert.notEqual(accessPrint(ana), accessPrint({ ...ana, agents: { 'bot-a': 'owner' } }))
  assert.notEqual(accessPrint(ana), accessPrint({ ...ana, role: 'superadmin' }))
  assert.notEqual(accessPrint(ana), accessPrint({ ...ana, id: 'staff-2' }))
})

// ---------------------------------------------------------------------------
// Reading the browser's WebSocket frames

test('the frame reader reassembles messages and passes control frames as sent', () => {
  const reader = createFrameReader()
  const ping = clientFrame('hi', { opcode: 9 })
  const bytes = Buffer.concat([clientFrame('{"a":', { fin: false }), ping, clientFrame('1}', { opcode: 0 }), clientFrame('x'.repeat(70_000))])
  const events = []
  // In small pieces that split frames and headers, as a slow link delivers them.
  for (let index = 0; index < bytes.length; index += 7) events.push(...reader.push(bytes.subarray(index, index + 7)))
  assert.deepEqual(events.map(event => (event.control ? ['control', event.control.equals(ping)] : [event.opcode, event.data.length])), [['control', true], [1, 7], [1, 70_000]])
  assert.equal(events[1].data.toString(), '{"a":1}')
  assert.deepEqual(createFrameReader().push(maskedFrame(1, Buffer.from('héllo'))).map(event => event.data.toString()), ['héllo'])
  assert.deepEqual(createFrameReader().push(maskedFrame(2, Buffer.alloc(300, 7)))[0].data, Buffer.alloc(300, 7))
})

test('the frame reader refuses what a browser never sends', () => {
  const refused = (bytes, why) => assert.throws(() => createFrameReader({ maxMessage: 1024 }).push(bytes), FrameError, why)
  refused(clientFrame('x', { masked: false }), 'unmasked')
  refused(Buffer.from([0xc1, 0x81, 0, 0, 0, 0, 0]), 'reserved bit (compression)')
  refused(clientFrame('x', { opcode: 0 }), 'continuation without a message')
  refused(Buffer.concat([clientFrame('a', { fin: false }), clientFrame('b')]), 'new message inside a fragmented one')
  refused(clientFrame('x', { opcode: 3 }), 'unknown opcode')
  refused(clientFrame('x', { opcode: 9, fin: false }), 'fragmented control frame')
  refused(clientFrame('x'.repeat(2000)), 'too large')
  refused(Buffer.concat([clientFrame('x'.repeat(600), { fin: false }), clientFrame('x'.repeat(600), { opcode: 0 })]), 'message too large')
})

// ---------------------------------------------------------------------------
// The gateway, with Ana (owner of bot-a, reader of bot-b) and a superadmin

const BOSS = { staff: { id: 'staff-boss', email: 'boss@example.com', displayName: 'Bea Boss', role: 'superadmin' }, agents: {} }

async function people(env) {
  env.sla.answers.set('cognito-sub-boss', BOSS)
  const ana = (await signIn(env)).cookie
  const boss = (await signIn(env, { claims: { sub: 'cognito-sub-boss', email: 'boss@example.com' } })).cookie
  return { ana, boss }
}

const envelope = (endpoint, args, method = endpoint) => JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload: { args } })
const call = (env, cookie, endpoint, args, { body, path = `/api/${endpoint}` } = {}) => env.request({
  method: 'POST',
  path,
  headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
  body: body ?? envelope(endpoint, args),
})
const reached = (env, endpoint) => env.dsh.requests.filter(seen => seen.url.split('?')[0] === `/api/${endpoint}`).length
const asked = env => env.dsh.accessCalls.length
const refusal = response => (response.status === 200 ? JSON.parse(response.body).result?.error : undefined)

function argsFor(rule, id) {
  const args = {}
  for (const path of rule.paths ?? []) {
    const keys = path.split('.')
    let node = args
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {})
    node[keys.at(-1)] = keys.at(-1) === 'address' ? { kind: 'session', sessionId: id } : id
  }
  return args
}

const unary = need => Object.entries(RULES).filter(([endpoint, rule]) => rule.need === need && rule.stream !== true && !DENIED_ENDPOINTS.has(endpoint))

test('every read and write call follows the caller\'s role on its Session', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const rules = [...unary('read'), ...unary('write')]
  assert.ok(rules.length > 30, `${rules.length} rules`)
  for (const [endpoint, rule] of rules) {
    const before = reached(env, endpoint)
    // Her own Bot: everything passes.
    assert.equal(refusal(await call(env, ana, endpoint, argsFor(rule, 'sess-a'))), undefined, `${endpoint} on her Bot`)
    assert.equal(reached(env, endpoint), before + 1, endpoint)
    // A Bot she reads: reads pass, writes are refused before dsh.
    const onShared = refusal(await call(env, ana, endpoint, argsFor(rule, 'sess-b')))
    if (rule.need === 'read') assert.equal(onShared, undefined, `${endpoint} on a Bot she reads`)
    else assert.deepEqual(onShared, { code: 'atenea/forbidden', message: 'Readers can only view this conversation', details: { endpoint } }, endpoint)
    assert.equal(reached(env, endpoint), before + (rule.need === 'read' ? 2 : 1), endpoint)
    // A Bot not shared with her, and a Session of DSH's own: as if they did not exist.
    for (const id of ['sess-c', 'dsh-own']) {
      assert.equal(refusal(await call(env, ana, endpoint, argsFor(rule, id)))?.message, 'Unknown conversation', `${endpoint} on ${id}`)
    }
    assert.equal(reached(env, endpoint), before + (rule.need === 'read' ? 2 : 1), endpoint)
  }
})

test('calls that make or rearrange Sessions outside a Bot are for superadmins', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana, boss } = await people(env)
  const rules = unary('superadmin')
  assert.deepEqual(rules.map(([endpoint]) => endpoint).sort(), ['credentials/set', 'credentials/unset', 'llm/discoverModels', 'session/create', 'session/fork', 'session/workspacePathApplications', 'settings/mutate', 'settings/openSettingsDocument', 'settings/replace', 'settings/update', 'workspace/archiveSession', 'workspace/create', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore', 'workspace/rename', 'workspace/unarchiveSession'].filter(endpoint => !DENIED_ENDPOINTS.has(endpoint)))
  for (const [endpoint] of rules) {
    assert.equal(refusal(await call(env, ana, endpoint, { request: { sessionId: 'sess-a' } }))?.message, 'Only a superadmin can do this', endpoint)
    assert.equal(reached(env, endpoint), 0, endpoint)
    assert.equal(refusal(await call(env, boss, endpoint, { request: { sessionId: 'sess-a' } })), undefined, endpoint)
    assert.equal(reached(env, endpoint), 1, endpoint)
  }
  // The path policy still comes first, for everyone.
  for (const endpoint of DENIED_ENDPOINTS) assert.equal((await call(env, boss, endpoint, {})).status, 403, endpoint)
})

test('calls that name no Session pass without asking ds-bot', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const rules = unary('open').filter(([, rule]) => rule.items === undefined)
  assert.ok(rules.length >= 12, `${rules.length} rules`)
  for (const [endpoint] of rules) {
    assert.equal(refusal(await call(env, ana, endpoint, {})), undefined, endpoint)
    assert.equal(reached(env, endpoint), 1, endpoint)
  }
  assert.equal(asked(env), 0)
})

test('a method dsh gains in an allowed namespace is refused until it has a rule', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana, boss } = await people(env)
  assert.equal(refusal(await call(env, ana, 'session/brandNew', { request: { sessionId: 'sess-a' } }))?.message, 'This action is not available on a shared Atenea server')
  // A stream method called as a unary one has no unary rule either.
  assert.equal(refusal(await call(env, ana, 'session/follow', { request: { address: { kind: 'session', sessionId: 'sess-a' } } }))?.code, 'atenea/forbidden')
  assert.equal(reached(env, 'session/brandNew') + reached(env, 'session/follow'), 0)
  assert.equal(refusal(await call(env, boss, 'session/brandNew', {})), undefined)
  assert.equal(reached(env, 'session/brandNew'), 1)
})

test('a superadmin passes every Session check without asking ds-bot', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { boss } = await people(env)
  for (const id of ['sess-c', 'dsh-own']) {
    assert.equal(refusal(await call(env, boss, 'session/prompt', { request: { sessionId: id, content: [{ type: 'text', text: reference('sess-c') }] } })), undefined)
  }
  assert.equal((await env.request({ path: '/api/session.export?sessionId=sess-c', headers: { cookie: boss } })).status, 200)
  const list = JSON.parse((await call(env, boss, 'session/list', { _request: {} })).body)
  assert.equal(list.result.value.items.length, env.dsh.rows.length)
  assert.equal(asked(env), 0)
})

test('Session lists, search hits and mention candidates show only the Sessions the caller reads', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const ids = response => {
    const value = JSON.parse(response.body).result.value
    return (Array.isArray(value) ? value : value.items).map(row => row.sessionId).sort()
  }
  assert.deepEqual(ids(await call(env, ana, 'session/list', { _request: {} })), ['sess-a', 'sess-b', 'sub-a'])
  assert.deepEqual(ids(await call(env, ana, 'session/search', { request: { query: 'plan' } })), ['sess-a', 'sess-b', 'sub-a'])
  assert.deepEqual(ids(await call(env, ana, 'sessionReferenceResolver/candidates', { agentId: 'sess-a', query: '' })), ['sess-a', 'sess-b', 'sub-a'])
  // The candidates of a conversation she cannot read are not asked for at all.
  assert.equal(refusal(await call(env, ana, 'sessionReferenceResolver/candidates', { agentId: 'sess-c', query: '' }))?.message, 'Unknown conversation')
  // An answer the gateway cannot read is not passed on unfiltered.
  env.dsh.statusFor.set('/api/session/list', 204)
  assert.equal((await call(env, ana, 'session/list', { _request: {} })).status, 502)
})

test('ds-bot\'s answers are kept for a while per person and Session, and dropped on 401 or 403', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const get = () => call(env, ana, 'goals/get', { agentId: 'sess-a' })
  await Promise.all([get(), get(), get(), call(env, ana, 'commands/list', { agentId: 'sess-a' })])
  assert.equal(asked(env), 1, 'parallel calls share one question')
  await get()
  assert.equal(asked(env), 1)
  env.clock.advance(ACCESS_TTL_MS)
  await get()
  assert.equal(asked(env), 2, 'asked again after the cache time')
  // dsh refusing a checked call drops what ds-bot said about this person.
  env.dsh.statusFor.set('/api/goals/get', 403)
  assert.equal((await get()).status, 403)
  env.dsh.statusFor.delete('/api/goals/get')
  await get()
  assert.equal(asked(env), 3)
  // One question names every Session a call needs.
  await call(env, ana, 'subagents/prompt', { request: { parentSessionId: 'sess-a', childSessionId: 'sub-a', content: [] } })
  assert.deepEqual(env.dsh.accessCalls.at(-1), { sub: 'staff-1', ids: ['sub-a'] })
  assert.equal(env.gateway.sessionAccess.size, 2)
  env.clock.advance(ACCESS_TTL_MS)
  await env.gateway.sweep()
  assert.equal(env.gateway.sessionAccess.size, 0)
})

test('when ds-bot cannot answer, the call is refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const prompt = () => call(env, ana, 'session/prompt', { request: { sessionId: 'sess-a', content: [] } })
  env.dsh.accessAnswer = () => ({ status: 200, body: { ok: false, error: { code: 'bot/unavailable', message: 'off', details: {} } } })
  assert.equal((await prompt()).status, 503)
  env.dsh.accessAnswer = () => ({ status: 401, body: { ok: false, error: { code: 'bot/auth-required', message: 'Sign in', details: {} } } })
  assert.equal((await prompt()).status, 503)
  env.dsh.accessAnswer = () => ({ status: 200, body: { ok: true, value: { sessions: { 'sess-a': { allowed: 'everything' } } } } })
  assert.equal(refusal(await prompt())?.message, 'Unknown conversation')
  assert.equal(reached(env, 'session/prompt'), 0)
  // A stale dsh cookie is traded again and the question asked once more.
  env.clock.advance(ACCESS_TTL_MS)
  env.dsh.accessAnswer = undefined
  env.dsh.restart()
  env.writeLaunch()
  assert.equal(refusal(await prompt()), undefined)
  assert.equal(reached(env, 'session/prompt'), 1)
})

test('a call that is not a dsh call for its path, or too large to read, is refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const args = { request: { sessionId: 'sess-a', content: [] } }
  assert.equal((await call(env, ana, 'session/prompt', null, { body: envelope('session/page', args) })).status, 400)
  assert.equal((await call(env, ana, 'session/prompt', null, { body: 'not json' })).status, 400)
  assert.equal((await call(env, ana, 'session/prompt', null, { body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/prompt', payload: { args: [] } }) })).status, 400)
  assert.equal((await call(env, ana, 'session/prompt', { request: { content: [] } })).status, 400)
  assert.equal((await call(env, ana, 'session/prompt', null, { body: envelope('session/prompt', { request: { sessionId: 'sess-a', content: [{ type: 'text', text: 'x'.repeat(GUARD_BODY_LIMIT) }] } }) })).status, 413)
  assert.equal(reached(env, 'session/prompt'), 0)
  // dsh reads a body with a byte order mark too, so the gateway does.
  assert.equal(refusal(await call(env, ana, 'session/prompt', null, { body: `﻿${envelope('session/prompt', { request: { sessionId: 'sess-c', content: [] } })}` }))?.message, 'Unknown conversation')
})

test('a message may mention only conversations the sender can read, in dsh and in ds-bot\'s channel', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const prompt = text => call(env, ana, 'session/prompt', { request: { sessionId: 'sess-a', content: [{ type: 'text', text }] } })
  assert.equal(refusal(await prompt(`summarize @[it](${reference('sess-c')})`))?.message, 'A message can only mention conversations you can read')
  assert.equal(refusal(await prompt(`compare ${reference('dsh-own')}`))?.message, 'A message can only mention conversations you can read')
  assert.equal(refusal(await prompt('dsh-session:!!'))?.message, 'A message can only mention conversations you can read')
  assert.equal(reached(env, 'session/prompt'), 0)
  assert.equal(refusal(await prompt(`compare ${reference('sess-b')}`)), undefined)
  assert.equal(reached(env, 'session/prompt'), 1)
  // The same mention in a call with no Session of its own.
  assert.equal(refusal(await call(env, ana, 'agentPresets/read', { agentPreset: reference('sess-c') }))?.code, 'atenea/forbidden')

  const bot = payload => env.request({ method: 'POST', path: '/api/bot', headers: { cookie: ana, origin: PUBLIC_URL, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'send', payload }) })
  const refused = await bot({ sessionId: 'sess-a', text: `see ${reference('sess-c')}` })
  assert.equal(refused.status, 403)
  assert.deepEqual(JSON.parse(refused.body), { ok: false, error: { code: 'bot/forbidden', message: 'A message can only mention conversations you can read', details: {} } })
  assert.equal(env.dsh.requests.filter(seen => seen.url === '/api/bot' && seen.body.includes('"send"')).length, 0)
  assert.equal((await bot({ sessionId: 'sess-a', text: `see ${reference('sess-b')}` })).status, 200)
  assert.equal((await bot({ sessionId: 'sess-a', text: 'plain' })).status, 200)
})

test('the Session log download and the raw upload check the Session in their query', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const download = query => env.request({ path: `/api/session.export${query}`, headers: { cookie: ana } })
  assert.equal((await download('?sessionId=sess-b&includeDescendants=true')).status, 200)
  assert.equal((await download('?sessionId=sess-c')).status, 404)
  assert.equal((await download('?sessionId=sess-b&sessionId=sess-c')).status, 400)
  assert.equal((await download('')).status, 400)
  const upload = id => env.request({ method: 'POST', path: `/api/session/uploadFileBinary?sessionId=${id}&name=a.png`, headers: { cookie: ana, origin: PUBLIC_URL, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(2048, 1) })
  assert.equal((await upload('sess-b')).status, 403)
  assert.equal((await upload('sess-c')).status, 404)
  assert.equal((await upload('sess-a')).status, 200)
  assert.equal(env.dsh.requests.filter(seen => seen.url.startsWith('/api/session/uploadFileBinary')).at(-1).body.length, 2048)
  assert.equal(ROUTE_RULES['/api/session/uploadFileBinary'].need, 'write')
})

// ---------------------------------------------------------------------------
// Remote streams on /api/remote.mux

async function until(check, what) {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 3000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const opened = (streamId, endpoint, args = {}) => JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })
const follow = (streamId, address) => opened(streamId, 'session/follow', { request: { address, assistantStream: true } })

async function mux(env, cookie, messages) {
  const ws = await openWebSocket(env.port, { headers: { Cookie: cookie, Origin: PUBLIC_URL } })
  assert.equal(ws.status, 101)
  const start = env.dsh.frames.length
  for (const message of messages) ws.socket.write(Buffer.isBuffer(message) ? message : clientFrame(message))
  return { ws, frames: () => env.dsh.frames.slice(start), start }
}

test('a stream on a Session opens only for those who may read it; the rest fail alone', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const messages = [
    follow('1', { kind: 'session', sessionId: 'sess-a' }),
    follow('2', { kind: 'session', sessionId: 'sess-c' }),
    opened('3', '$events'),
    opened('4', 'session/control'),
    opened('5', 'workspace/follow'),
    opened('6', 'job/list', { request: { sessionId: 'sess-b' } }),
    opened('7', 'job/follow', { request: { sessionId: 'dsh-own', jobId: 'j', from: 0 } }),
    opened('8', 'userQuestions/attachWait', { agentId: 'sess-b', callId: 'c' }),
    follow('9', { kind: 'subagent', parentSessionId: 'sess-a', childSessionId: 'sub-a', mode: 'unknown' }),
    follow('10', { kind: 'subagent', parentSessionId: 'sess-a', childSessionId: 'sess-c', mode: 'unknown' }),
    opened('11', 'terminal/attach', { agentId: 'sess-a', id: 't' }),
    opened('12', 'session/brandNewStream', {}),
    opened('13', 'session/prompt', { request: { sessionId: 'sess-a' } }),
    follow('14', 'sess-a'),
    JSON.stringify({ type: 'cancel', streamId: '2' }),
  ]
  const { ws, frames } = await mux(env, ana, messages)
  t.after(() => ws.socket.destroy())
  await until(() => frames().length === messages.length, 'every message')
  const passed = new Set(['1', '3', '4', '5', '6', '8', '9'])
  frames().forEach((frame, index) => {
    assert.equal(frame.masked, true)
    const sent = JSON.parse(messages[index])
    if (sent.type !== 'open' || passed.has(sent.streamId)) assert.equal(frame.text, messages[index], `stream ${sent.streamId}`)
    else assert.deepEqual(JSON.parse(frame.text), { type: 'open', streamId: sent.streamId, endpoint: DENIED_STREAM_ENDPOINT, payload: { args: {} } }, `stream ${sent.streamId}`)
  })
})

test('a superadmin opens any stream of an allowed namespace, and none outside them', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { boss } = await people(env)
  const messages = [follow('1', { kind: 'session', sessionId: 'sess-c' }), opened('2', 'session/brandNewStream'), opened('3', 'terminal/attach', { agentId: 'sess-a', id: 't' }), opened('4', 'account/watch')]
  const { ws, frames } = await mux(env, boss, messages)
  t.after(() => ws.socket.destroy())
  await until(() => frames().length === messages.length, 'every message')
  assert.deepEqual(frames().map(frame => JSON.parse(frame.text).endpoint), ['session/follow', 'session/brandNewStream', DENIED_STREAM_ENDPOINT, DENIED_STREAM_ENDPOINT])
  assert.equal(asked(env), 0)
})

test('a fragmented open is decided whole, and control frames keep their place', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  const text = follow('1', { kind: 'session', sessionId: 'sess-c' })
  const ping = clientFrame('', { opcode: 9 })
  const { ws, frames } = await mux(env, ana, [clientFrame(text.slice(0, 20), { fin: false }), ping, clientFrame(text.slice(20), { opcode: 0 }), clientFrame('', { opcode: 10 })])
  t.after(() => ws.socket.destroy())
  await until(() => frames().length === 3, 'three frames')
  assert.deepEqual(frames().map(frame => frame.opcode), [9, 1, 10])
  assert.equal(JSON.parse(frames()[1].text).endpoint, DENIED_STREAM_ENDPOINT)
})

test('a WebSocket message dsh would refuse, or a frame a browser never sends, closes the socket', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  for (const bad of [clientFrame('{}', { masked: false }), clientFrame('{"type":"open"', {}), clientFrame(Buffer.from([1, 2, 3]), { opcode: 2 }), clientFrame(JSON.stringify({ type: 'open', streamId: 1, endpoint: 'session/control', payload: { args: {} } }))]) {
    const { ws, frames } = await mux(env, ana, [bad])
    await closed(ws.socket)
    assert.equal(frames().length, 0)
  }
})

test('a dsh that answers the handshake with compression is refused', async (t) => {
  const env = await startEnv()
  t.after(() => env.close())
  const { ana } = await people(env)
  env.dsh.wsExtension = 'permessage-deflate'
  const ws = await openWebSocket(env.port, { headers: { Cookie: ana, Origin: PUBLIC_URL } })
  t.after(() => ws.socket.destroy())
  assert.equal(ws.status, 502)
})
