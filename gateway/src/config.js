// The gateway's settings, read once from the environment. A bad value stops the start
// instead of running half configured.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const MIN_SECRET_LENGTH = 32

class ConfigError extends Error {}

function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`${name} is required`)
  return value
}

function parseUrl(name, value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} is not a URL`)
  }
  if (url.username || url.password) throw new ConfigError(`${name} must not carry credentials`)
  return url
}

// Plain http only for loopback addresses, as in local tests.
function httpsUrl(name, value) {
  const url = parseUrl(name, value)
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  if (!ok) throw new ConfigError(`${name} must be an https URL`)
  return url
}

function origin(name, value) {
  const url = httpsUrl(name, value)
  if (url.pathname !== '/' || url.search || url.hash) throw new ConfigError(`${name} must be an origin, without a path`)
  return url.origin
}

function port(name, value, fallback) {
  const text = value?.trim() || String(fallback)
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new ConfigError(`${name} must be a port number`)
  return Number(text)
}

export function loadConfig(env = process.env) {
  const issuer = httpsUrl('COGNITO_ISSUER', required(env, 'COGNITO_ISSUER')).href.replace(/\/$/, '')
  const upstream = parseUrl('DSH_UPSTREAM', env.DSH_UPSTREAM?.trim() || 'http://127.0.0.1:13080')
  if (upstream.protocol !== 'http:' || upstream.pathname !== '/' || upstream.search) {
    throw new ConfigError('DSH_UPSTREAM must be an http origin such as http://127.0.0.1:13080')
  }
  const launchUrl = env.DSH_LAUNCH_URL?.trim() || undefined
  const launchUrlFile = env.DSH_LAUNCH_URL_FILE?.trim() || undefined
  if (!launchUrl && !launchUrlFile) throw new ConfigError('DSH_LAUNCH_URL or DSH_LAUNCH_URL_FILE is required')
  const identitySecret = required(env, 'ATENEA_IDENTITY_SECRET')
  if (identitySecret.length < MIN_SECRET_LENGTH) throw new ConfigError(`ATENEA_IDENTITY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  const sla = httpsUrl('SLA_URL', required(env, 'SLA_URL'))
  const fileRoots = (env.GATEWAY_FILE_ROOTS ?? '/workspace').split(',').map(root => root.trim().replace(/\/+$/, '')).filter(Boolean)
  for (const root of fileRoots) {
    if (!root.startsWith('/')) throw new ConfigError('GATEWAY_FILE_ROOTS must list absolute paths')
  }
  return {
    host: env.GATEWAY_HOST?.trim() || '127.0.0.1',
    port: port('GATEWAY_PORT', env.GATEWAY_PORT, 13081),
    publicUrl: origin('PUBLIC_URL', required(env, 'PUBLIC_URL')),
    cognito: {
      domain: origin('COGNITO_DOMAIN', required(env, 'COGNITO_DOMAIN')),
      issuer,
      clientId: required(env, 'COGNITO_CLIENT_ID'),
      clientSecret: env.COGNITO_CLIENT_SECRET?.trim() || undefined,
    },
    slaUrl: sla.href.replace(/\/$/, ''),
    identitySecret,
    dsh: { upstream: upstream.origin, launchUrl, launchUrlFile },
    fileRoots,
  }
}

export { ConfigError }
