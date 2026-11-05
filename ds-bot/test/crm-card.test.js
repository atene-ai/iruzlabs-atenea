import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

// The CRM card imports react; only its pure parts run here.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { accountGroups, levelLabel } from './src/client/crm-card.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = { createElement: () => null, useState: initial => [initial, () => {}], useEffect() {} }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}) })
const { accountGroups, levelLabel } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

test('the CRM card splits SLA accounts from the person\'s own, each by name', () => {
  const view = {
    accounts: [
      { ref: 'sla:2', via: 'grant', name: 'Zeta', level: 'read' },
      { ref: 'own:1', via: 'own', name: 'Mía', level: 'operate' },
      { ref: 'sla:1', via: 'grant', name: 'Alfa', level: 'operate' },
    ],
  }
  const { staff, own } = plain(accountGroups(view))
  assert.deepEqual(staff.map(account => account.ref), ['sla:1', 'sla:2'])
  assert.deepEqual(own.map(account => account.ref), ['own:1'])
  assert.deepEqual(plain(accountGroups(null)), { staff: [], own: [] })
})

test('a level the card does not know reads as read only', () => {
  assert.equal(levelLabel('operate'), 'Read and change')
  assert.equal(levelLabel('read'), 'Read only')
  assert.equal(levelLabel('admin'), 'Read only')
})
