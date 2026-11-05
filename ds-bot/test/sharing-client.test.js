import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// The shared-server helpers import react; only their pure parts run here.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { readOnlyTargets, installReadOnlyComposer, watchSubmissions, authorCache } from './src/client/multiuser.js'\nexport { unshared } from './src/client/sharing.js'",
    resolveDir: root,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = { createElement: () => null, useState: initial => [initial, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment' }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, setTimeout, require: name => (name === 'react' ? react : {}) })
const { readOnlyTargets, installReadOnlyComposer, watchSubmissions, authorCache, unshared } = module.exports
// Values made in the bundle's own realm compare by their JSON.
const plain = value => JSON.parse(JSON.stringify(value))

const roster = {
  multiuser: true,
  bots: [
    { id: 'a', sessionId: 'a2', parts: ['a'], access: { write: false } },
    { id: 'b', sessionId: 'b', access: { write: true } },
  ],
  rooms: [{ id: 'r', sessionId: 'r3', ownParts: ['r', 'r2'], access: { write: false } }],
}

test('every part of a chat the viewer may only read is read-only, and nothing is off a shared server', () => {
  const targets = readOnlyTargets(roster)
  assert.deepEqual([...targets.keys()].sort(), ['a', 'a2', 'r', 'r2', 'r3'])
  assert.equal(targets.get('a'), targets.get('a2'))
  assert.equal(targets.get('r3').kind, 'room')
  assert.equal(readOnlyTargets({ ...roster, multiuser: undefined }).size, 0)
})

test('the read-only composer registers again only when the read-only chats change', () => {
  const registered = []
  const listeners = new Set()
  let value = roster
  const source = { getSnapshot: () => value, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  const slots = {
    entries: () => [{ options: { priority: -100 }, component: 'question' }],
    register: (options) => { const entry = { options, live: true }; registered.push(entry); return () => { entry.live = false } },
  }
  const dispose = installReadOnlyComposer(slots, source, 'readonly', -100)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.priority, -101)
  assert.equal(registered[0].options.select({ sessionId: 'a2' }).id, 'a')
  assert.equal(registered[0].options.select({ sessionId: 'b' }), null)
  value = { ...roster, bots: [...roster.bots] }
  for (const fn of listeners) fn()
  assert.equal(registered.length, 1)
  value = { ...roster, rooms: [] }
  for (const fn of listeners) fn()
  assert.equal(registered.length, 2)
  assert.equal(registered[0].live, false)
  dispose()
  assert.equal(registered[1].live, false)
  assert.equal(listeners.size, 0)
})

test('each composer submission is claimed once, across bindings', () => {
  const claimed = []
  let snapshot = { pendingSubmissions: [{ requestId: 'q1' }] }
  let listener
  const session = { getSnapshot: () => snapshot, subscribe: (fn) => { listener = fn; return () => { listener = undefined } } }
  const seen = new Set()
  const off = watchSubmissions(session, seen, id => claimed.push(id))
  snapshot = { pendingSubmissions: [{ requestId: 'q1' }, { requestId: 'q2' }] }
  listener()
  off()
  assert.equal(listener, undefined)
  watchSubmissions(session, seen, id => claimed.push(id))
  assert.deepEqual(claimed, ['q1', 'q2'])
})

test('authors are asked in one batch, never twice once known, and again a few times while unknown', async () => {
  const tasks = []
  const timers = []
  let clock = 0
  const cache = authorCache({ schedule: fn => tasks.push(fn), later: (fn, ms) => timers.push({ fn, ms }), now: () => clock })
  const asked = []
  const fetchAuthors = async (ids) => { asked.push(ids); return { m1: { id: 's1', name: 'Ana' } } }
  cache.request('m1', fetchAuthors)
  cache.request('m2', fetchAuthors)
  cache.request('m1', fetchAuthors)
  assert.equal(tasks.length, 1)
  await tasks.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(plain(asked), [['m1', 'm2']])
  assert.deepEqual(plain(cache.get('m1')), { id: 's1', name: 'Ana' })
  assert.equal(cache.get('m2'), undefined)
  cache.request('m1', fetchAuthors)
  assert.equal(tasks.length, 0)
  clock = 2000
  timers.shift().fn()
  assert.equal(tasks.length, 1)
  await tasks.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(plain(asked.at(-1)), ['m2'])
})

test('a staff search lists only people the Bot is not shared with yet', () => {
  assert.deepEqual(plain(unshared([{ id: 's1' }, { id: 's2' }], [{ id: 's1', role: 'editor' }])), [{ id: 's2' }])
  assert.deepEqual(plain(unshared(null, [])), [])
})
