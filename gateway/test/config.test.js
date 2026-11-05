import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, loadConfig } from '../src/config.js'
import { launchToken } from '../src/dsh.js'

const env = {
  COGNITO_DOMAIN: 'https://atenea-test.auth.mx-central-1.amazoncognito.com',
  COGNITO_ISSUER: 'https://cognito-idp.mx-central-1.amazonaws.com/mx-central-1_testpool/',
  COGNITO_CLIENT_ID: 'test-client-id',
  PUBLIC_URL: 'https://ia.example.test',
  SLA_URL: 'https://sla.example.test/',
  ATENEA_IDENTITY_SECRET: 'test-identity-secret-0123456789abcdef',
  DSH_LAUNCH_URL_FILE: '/run/atenea/dsh-launch-url',
}

test('defaults: loopback on 13081, dsh on 127.0.0.1:13080, /workspace for files', () => {
  const config = loadConfig(env)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 13081)
  assert.equal(config.dsh.upstream, 'http://127.0.0.1:13080')
  assert.equal(config.cognito.issuer, 'https://cognito-idp.mx-central-1.amazonaws.com/mx-central-1_testpool')
  assert.equal(config.slaUrl, 'https://sla.example.test')
  assert.equal(config.cognito.clientSecret, undefined)
  assert.deepEqual(config.fileRoots, ['/workspace'])
})

test('missing or unsafe settings stop the start', () => {
  for (const [name, value] of [
    ['COGNITO_CLIENT_ID', ''],
    ['ATENEA_IDENTITY_SECRET', 'too-short'],
    ['PUBLIC_URL', 'http://ia.example.test'],
    ['PUBLIC_URL', 'https://ia.example.test/app'],
    ['COGNITO_DOMAIN', 'https://user:pass@auth.example.test'],
    ['DSH_UPSTREAM', 'https://127.0.0.1:13080'],
    ['GATEWAY_PORT', '70000'],
    ['GATEWAY_FILE_ROOTS', 'workspace'],
  ]) {
    assert.throws(() => loadConfig({ ...env, [name]: value }), ConfigError, `${name}=${value}`)
  }
  assert.throws(() => loadConfig({ ...env, DSH_LAUNCH_URL_FILE: '' }), /DSH_LAUNCH_URL/)
})

test('the launch token is read from a URL or a whole dsh web line', () => {
  assert.equal(launchToken('http://127.0.0.1:3080/?token=abc123'), 'abc123')
  assert.equal(launchToken('dsh web: http://127.0.0.1:3080/?token=a%2Bb (LAN: http://172.17.0.2:3080/?token=a%2Bb)\n'), 'a+b')
  assert.equal(launchToken('dsh web: http://127.0.0.1:3080/'), undefined)
})
