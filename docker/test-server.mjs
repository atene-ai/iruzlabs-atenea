// Server mode (ATENEA_SERVER_MODE=1) of the image, with the gateway image beside it:
//   docker build -f docker/Dockerfile -t ds-bot:local .
//   docker build -t atenea-gateway:local gateway
//   node docker/test-server.mjs ds-bot:local atenea-gateway:local
// Containers run on an internal network with temporary volumes; no model is called. It checks
// that the launch URL reaches the shared volume as a 0600 file and not the log, that the
// owner-only features of server.patch.yml are gone while chat calls still answer, that the
// gateway takes dsh's owner cookie through the volume, and that a bad mode value stops.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2] ?? 'ds-bot:local'
const gatewayImage = process.argv[3] ?? 'atenea-gateway:local'
const name = `atenea-server-test-${randomUUID()}`
const network = `${name}-net`
const volumes = [`${name}-data`, `${name}-workspace`, `${name}-launch`]
const containers = new Set()
let networkCreated = false

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}`)
  }
  return result
}

const mounts = [
  '--mount', `type=volume,src=${volumes[0]},dst=/data`,
  '--mount', `type=volume,src=${volumes[1]},dst=/workspace`,
  '--mount', `type=volume,src=${volumes[2]},dst=/run/atenea`,
]

async function until(check, what, ms = 60_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await setTimeout(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Runs inside the dsh container: trades the token from a launch file and calls dsh.
const probe = `
  const { readFileSync } = await import('node:fs')
  const [file, ...endpoints] = process.argv.slice(1)
  const token = new URL(readFileSync(file, 'utf8').match(/https?:\\/\\/\\S+/)[0]).searchParams.get('token')
  const exchange = await fetch('http://127.0.0.1:3080/?token=' + encodeURIComponent(token), { redirect: 'manual' })
  const cookie = exchange.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  const call = async (endpoint, args = {}) => {
    const response = await fetch('http://127.0.0.1:3080/api/' + endpoint, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
    })
    return response.status
  }
  const result = { exchange: exchange.status }
  for (const endpoint of endpoints) result[endpoint] = await call(endpoint)
  console.log(JSON.stringify(result))
`

const endpoints = ['terminal/shells', 'pluginManager/listBundles', 'account/getState', 'workspaceFiles/stat', 'permissionPresets/catalog', 'settings/describe']

function startDsh(container, mode) {
  containers.add(container)
  docker([
    'run', '--detach', '--name', container, '--network', network, '--network-alias', 'atenea', ...mounts,
    '-e', 'PUID=1234', '-e', 'PGID=1235', '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'ATENEA_AUTH_REQUIRED=0',
    '-e', 'DSH_TRUSTED_HOST=atenea', '-e', `ATENEA_SERVER_MODE=${mode}`, image,
  ])
}

const logsOf = container => {
  const result = docker(['logs', container], { allowFailure: true })
  return `${result.stdout}${result.stderr}`
}

try {
  docker(['network', 'create', '--internal', network])
  networkCreated = true
  for (const volume of volumes) docker(['volume', 'create', volume])

  const bad = docker(['run', '--rm', '--network', 'none', ...mounts, '-e', 'ATENEA_SERVER_MODE=true', image], { allowFailure: true })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /ATENEA_SERVER_MODE must be 0 or 1/)
  console.log('PASS: an unknown ATENEA_SERVER_MODE stops the start')

  const server = `${name}-server`
  startDsh(server, '1')
  await until(() => docker(['exec', server, 'test', '-s', '/run/atenea/dsh-launch-url'], { allowFailure: true }).status === 0, 'the launch URL file')
  assert.equal(docker(['exec', server, 'stat', '-c', '%a %u:%g', '/run/atenea/dsh-launch-url']).stdout.trim(), '600 1234:1235')
  assert.equal(docker(['exec', server, 'stat', '-c', '%a %u:%g', '/run/atenea']).stdout.trim(), '700 1234:1235')
  const logs = logsOf(server)
  assert.match(logs, /dsh web: ready; launch URL written to \/run\/atenea\/dsh-launch-url/)
  assert.doesNotMatch(logs, /token=/)
  assert.equal(docker(['exec', server, 'stat', '-c', '%u:%g', '/proc/1']).stdout.trim(), '1234:1235', 'dsh stays PID 1')
  console.log('PASS: the launch URL goes to a 0600 file in the shared volume, not to the log')

  const blocked = JSON.parse(docker(['exec', server, 'node', '--input-type=module', '-e', probe, '/run/atenea/dsh-launch-url', ...endpoints]).stdout)
  assert.deepEqual(blocked, {
    exchange: 303,
    'terminal/shells': 404,
    'pluginManager/listBundles': 404,
    'account/getState': 404,
    'workspaceFiles/stat': 404,
    'permissionPresets/catalog': 200,
    'settings/describe': 200,
  })
  console.log('PASS: server.patch.yml removes the terminal, plugin manager, account and file service')

  const gateway = `${name}-gateway`
  containers.add(gateway)
  docker([
    'run', '--detach', '--name', gateway, '--network', network, '--user', '1234:1235', '--read-only', '--cap-drop', 'ALL',
    '--mount', `type=volume,src=${volumes[2]},dst=/run/atenea,readonly`,
    '-e', 'PUBLIC_URL=https://ia.example.test',
    '-e', 'COGNITO_DOMAIN=https://atenea-test.auth.mx-central-1.amazoncognito.com',
    '-e', 'COGNITO_ISSUER=https://cognito-idp.mx-central-1.amazonaws.com/mx-central-1_testpool',
    '-e', 'COGNITO_CLIENT_ID=test-client-id',
    '-e', 'SLA_URL=https://sla.example.test',
    '-e', 'ATENEA_IDENTITY_SECRET=test-identity-secret-0123456789abcdef',
    '-e', 'DSH_UPSTREAM=http://atenea:3080',
    '-e', 'DSH_LAUNCH_URL_FILE=/run/atenea/dsh-launch-url',
    gatewayImage,
  ])
  const health = `fetch('http://127.0.0.1:13081/healthz').then(r => r.text()).then(t => console.log(t))`
  let body = ''
  await until(() => {
    body = docker(['exec', gateway, 'node', '-e', health], { allowFailure: true }).stdout.trim()
    return body.includes('"dshSession":true')
  }, 'the gateway to take the dsh session')
  assert.deepEqual(JSON.parse(body), { ok: true, upstream: true, dshSession: true })
  assert.doesNotMatch(logsOf(gateway), /token=/)
  // fetch() ignores a Host header, so this one asks through node:http.
  const anonymous = `require('node:http').get({ host: '127.0.0.1', port: 13081, path: '/', headers: { host: 'ia.example.test', accept: 'text/html' } }, r => console.log(r.statusCode, r.headers.location))`
  assert.equal(docker(['exec', gateway, 'node', '-e', anonymous]).stdout.trim(), '302 /auth/login?return_to=%2F')
  console.log('PASS: the gateway reads the launch file through the volume and takes the dsh session')

  docker(['rm', '--force', server])
  containers.delete(server)
  const plain = `${name}-plain`
  startDsh(plain, '0')
  await until(() => logsOf(plain).includes('dsh web: http'), 'dsh web without server mode')
  const line = logsOf(plain).split('\n').find(text => text.startsWith('dsh web: http'))
  spawnSync('docker', ['exec', '-i', plain, 'sh', '-c', 'cat > /tmp/launch'], { input: `${line}\n` })
  const open = JSON.parse(docker(['exec', plain, 'node', '--input-type=module', '-e', probe, '/tmp/launch', 'terminal/shells', 'pluginManager/listBundles']).stdout)
  assert.equal(open.exchange, 303)
  assert.notEqual(open['terminal/shells'], 404)
  assert.notEqual(open['pluginManager/listBundles'], 404)
  console.log('PASS: without server mode the log keeps the dsh web URL and nothing is switched off')
} finally {
  for (const container of containers) docker(['rm', '--force', container], { allowFailure: true })
  for (const volume of volumes) docker(['volume', 'rm', volume], { allowFailure: true })
  if (networkCreated) docker(['network', 'rm', network], { allowFailure: true })
}
