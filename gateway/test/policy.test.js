import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from '../src/policy.js'

const options = { fileRoots: ['/workspace'] }

function verdict(method, target, upgrade = false) {
  const url = new URL(target, 'https://ia.example.test')
  return decide({ method, pathname: url.pathname, searchParams: url.searchParams, upgrade }, options)
}

const allowed = (method, target, upgrade) => verdict(method, target, upgrade).allow

test('the page, its assets and the plugin bundles load', () => {
  for (const target of ['/', '/index.html', '/assets/app-1234.js', '/plugins/ds-bot/client.js', '/plugins/events', '/favicon.ico']) {
    assert.ok(allowed('GET', target), target)
  }
  assert.equal(verdict('POST', '/').status, 405)
})

test('the ds-bot channel and its live feed pass', () => {
  assert.ok(allowed('POST', '/api/bot'))
  assert.ok(allowed('GET', '/api/bot/feed'))
  assert.equal(allowed('GET', '/api/bot'), false)
})

test('the Remote stream WebSocket passes only as an upgrade', () => {
  assert.ok(allowed('GET', '/api/remote.mux', true))
  assert.equal(allowed('GET', '/api/remote.mux'), false)
  assert.equal(allowed('GET', '/api/bot', true), false)
  assert.equal(allowed('GET', '/', true), false)
})

test('chat, Session and Workspace calls pass', () => {
  for (const endpoint of ['session/prompt', 'session/list', 'session/create', 'session/cancel', 'workspace/create', 'job/kill', 'goals/create',
    'userQuestions/answer', 'messageFeedback/put', 'commands/execute', 'fileUploads/upload', 'settings/describe', 'credentials/describe',
    'agentPresets/list', 'llm/listProviders', 'permissionPresets/catalog', 'session/uploadFileBinary']) {
    assert.ok(allowed('POST', `/api/${endpoint}`), endpoint)
    assert.equal(allowed('GET', `/api/${endpoint}`), false, endpoint)
  }
})

test('owner-only namespaces are blocked', () => {
  for (const endpoint of ['terminal/create', 'terminal/write', 'pluginManager/installBundle', 'pluginManager/setPluginEnabled', 'account/startSignIn',
    'workspaceFiles/read', 'directoryPicker/list', 'dynamicCordisRunner/runHostHalf', 'pluginRegistryProbe/fastest', 'productAnalytics/report', 'unknownNamespace/call']) {
    assert.deepEqual(verdict('POST', `/api/${endpoint}`), { allow: false, status: 403, reason: `blocked endpoint ${endpoint}` })
  }
})

test('settings and credential writers are blocked, their reads are not', () => {
  for (const endpoint of ['settings/mutate', 'settings/replace', 'settings/update', 'settings/openSettingsDocument', 'credentials/set', 'credentials/unset',
    'agentPresets/select', 'session/openWorkspacePath']) {
    assert.equal(verdict('POST', `/api/${endpoint}`).status, 403, endpoint)
  }
})

test('paths that are not a plain namespace and method are refused', () => {
  for (const target of ['/api/session/prompt/extra', '/api/session', '/api/session%2Fprompt/x', '/api/se%73sion/prompt', '/api/', '/api']) {
    assert.equal(allowed('POST', target), false, target)
  }
  // The URL parser resolves dot segments before the check, as dsh's does.
  assert.equal(verdict('POST', '/api/session/../terminal/create').reason, 'blocked endpoint terminal/create')
})

test('/api/file serves only the work folders', () => {
  assert.ok(allowed('GET', '/api/file?path=/workspace/report.png'))
  assert.ok(allowed('HEAD', '/api/file?path=/workspace/sub/chart.svg'))
  for (const target of ['/api/file?path=/data/.credentials.yaml', '/api/file?path=/workspace/../proc/1/environ', '/api/file?path=/workspace',
    '/api/file?path=/workspacex/a', '/api/file?path=relative.txt', '/api/file', '/api/file?path=/workspace/a&path=/etc/passwd']) {
    assert.equal(allowed('GET', target), false, target)
  }
})

test('host launchers, dsh account sign-in and the API cookie exchange are blocked', () => {
  for (const target of ['/connect?token=x', '/oauth/callback?code=x', '/open-in-app/apps', '/open-in-app/icon/x']) {
    assert.equal(verdict('GET', target).status, 404, target)
  }
  assert.equal(allowed('GET', '/api/changes.open'), false)
  assert.equal(allowed('POST', '/api/present.open'), false)
  assert.ok(allowed('GET', '/api/session.export?sessionId=s'))
})
