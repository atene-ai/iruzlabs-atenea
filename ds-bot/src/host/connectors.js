// Connectors: outside services every Bot can use (GitHub, Linear, Grafana Cloud, Google Workspace).
// Tools come from their respective MCP servers through DSH's own MCP client, mounted on the
// plugin context, so every Bot and Session gets them under their qualified namespace.
//
// Tokens and credentials are stored securely in secrets, redacted in logs, and kept out of
// ordinary Bot shells.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
export const LINEAR = 'linear'
export const LINEAR_SECRET = 'LINEAR_API_KEY'
export const GRAFANA = 'grafana'
export const GRAFANA_SECRET = 'GRAFANA_SERVICE_ACCOUNT_TOKEN'
export const GOOGLE_WORKSPACE = 'google-workspace'
export const GOOGLE_WORKSPACE_SECRET = 'GOOGLE_WORKSPACE_CREDENTIALS'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const CHECK_TIMEOUT_MS = 15_000
const INSECURE_GITHUB = 'GitHub addresses must start with https://'
const GOOGLE_CREDENTIALS_FILE = 'google-workspace-credentials.json'

// Exact versions: `npx -y name` runs whatever release is newest at mount time, with the
// connector's credentials in its environment. Raise a version only after reviewing it.
const DEFAULTS = {
  [GITHUB]: {
    url: 'https://api.githubcopilot.com/mcp/',
    api: 'https://api.github.com',
    toolsets: 'context,repos,issues,pull_requests',
  },
  [LINEAR]: {
    api: 'https://api.linear.app/graphql',
    command: 'npx',
    args: ['-y', '@emmett.deen/linear-mcp-server@1.0.0'],
  },
  [GRAFANA]: {
    command: 'npx',
    args: ['-y', '@leval/mcp-grafana@1.1.7'],
  },
  [GOOGLE_WORKSPACE]: {
    command: 'npx',
    args: ['-y', 'google-workspace-mcp@2.3.6'],
  },
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

// A Grafana base address the token may be sent to: https, or http on this computer only.
export function grafanaBase(url) {
  const text = String(url ?? '').trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('Enter a valid Grafana URL (starting with https://)')
  }
  const local = parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !local) throw new Error('Grafana addresses must start with https://')
  if (parsed.username || parsed.password) throw new Error('Leave the user name and password out of the Grafana URL')
  return text
}

export async function signInGithub(token, { api = DEFAULTS[GITHUB].api, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach GitHub')
  }
  if (response.status === 401) throw new Error('GitHub did not accept this token')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.login !== 'string') throw new Error('GitHub did not say who this token belongs to')
  return { login: user.login }
}

export async function signInLinear(token, { api = DEFAULTS[LINEAR].api, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(api, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': 'ds-bot' },
      body: JSON.stringify({ query: '{ viewer { id name email } }' }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Linear')
  }
  if (response.status === 401 || response.status === 403) throw new Error('Linear did not accept this API key')
  if (!response.ok) throw new Error(`Linear answered ${response.status}`)
  const json = await response.json().catch(() => ({}))
  if (json.errors?.length) {
    const msg = json.errors[0]?.message ?? ''
    if (/auth|unauthorized|forbidden|token|key/i.test(msg)) throw new Error('Linear did not accept this API key')
    throw new Error(`Linear: ${msg}`)
  }
  const viewer = json.data?.viewer
  const login = viewer?.name || viewer?.email || viewer?.id
  if (!login) throw new Error('Linear did not say who this key belongs to')
  return { login }
}

export async function signInGrafana(token, { url, fetch: request = fetch } = {}) {
  const base = grafanaBase(url)
  let response
  try {
    response = await request(`${base}/api/org`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'ds-bot' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Grafana')
  }
  if (response.status === 401 || response.status === 403) throw new Error('Grafana did not accept this token')
  if (!response.ok) throw new Error(`Grafana answered ${response.status}`)
  const org = await response.json().catch(() => ({}))
  const login = org?.name || base.replace(/^https?:\/\//, '')
  return { login }
}

// The credentials themselves, not their path, go into the secrets store: a path would
// leave them in a file outside it, readable by whatever else runs as the user.
export async function signInGoogleWorkspace(credentialsInput) {
  const trimmed = String(credentialsInput ?? '').trim()
  if (!trimmed) throw new Error('Paste Google Workspace OAuth credentials JSON or provide a valid path')
  let parsed = null
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('Invalid JSON format for Google Workspace credentials')
    }
  } else {
    if (!trimmed.toLowerCase().endsWith('.json') || !existsSync(trimmed)) {
      throw new Error('The credentials file does not exist. Provide valid JSON or an existing .json file path.')
    }
    try {
      parsed = JSON.parse(readFileSync(trimmed, 'utf8'))
    } catch {
      throw new Error('Could not read credentials JSON from the provided path')
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Google Workspace credentials must be a JSON object')
  }
  const root = parsed.installed ?? parsed.web ?? parsed
  const clientId = root.client_id
  const clientEmail = parsed.client_email
  const projectId = root.project_id ?? parsed.project_id
  if (!clientId && !clientEmail && !projectId) {
    throw new Error('Google Workspace credentials must contain client_id or client_email')
  }
  const login = projectId ? `Project: ${projectId}` : clientEmail ?? 'OAuth App'
  const credentialsJson = JSON.stringify(parsed)
  return { login, credentialsJson, secret: credentialsJson }
}

// The MCP server reads its credentials from a file; it is rewritten only when they
// change, kept private to the user, and removed when the connector is.
function writeGoogleCredentials(home, json) {
  const target = join(home, GOOGLE_CREDENTIALS_FILE)
  let current = null
  try { current = readFileSync(target, 'utf8') } catch {}
  if (current !== json) writeFileSync(target, json, { mode: 0o600 })
  // `mode` only applies when the file is created.
  try { chmodSync(target, 0o600) } catch {}
  return target
}

// Backward-compatible alias for existing tests
export const signIn = signInGithub

const CONNECTOR_DEFS = {
  [GITHUB]: {
    id: GITHUB,
    name: 'GitHub',
    secret: GITHUB_SECRET,
    purpose: 'GitHub connector',
    validate: (options) => {
      const insecure = options !== null && [options.url, options.api].some(address => !/^https:\/\//i.test(String(address)))
      if (insecure) throw new Error(INSECURE_GITHUB)
    },
    signIn: async (token, options) => signInGithub(token, { api: options.api }),
    mountConfig: (token, options) => ({
      transport: 'streamable-http',
      serverName: GITHUB,
      url: options.url,
      headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': options.toolsets },
      failOnStartupError: true,
    }),
  },
  [LINEAR]: {
    id: LINEAR,
    name: 'Linear',
    secret: LINEAR_SECRET,
    purpose: 'Linear connector',
    validate: () => {},
    signIn: async (token, options) => signInLinear(token, { api: options.api }),
    mountConfig: (token, options) => ({
      transport: 'stdio',
      serverName: LINEAR,
      command: options.command,
      args: options.args,
      env: { LINEAR_API_KEY: token, ...options.env },
      failOnStartupError: true,
    }),
  },
  [GRAFANA]: {
    id: GRAFANA,
    name: 'Grafana Cloud',
    secret: GRAFANA_SECRET,
    purpose: 'Grafana connector',
    address: (options, stateEntry, body) => {
      const url = body?.url ?? stateEntry?.url ?? options?.url
      if (!url) throw new Error('Enter the Grafana instance URL')
      return grafanaBase(url)
    },
    validate: (options, stateEntry, body) => { CONNECTOR_DEFS[GRAFANA].address(options, stateEntry, body) },
    signIn: async (token, options, body) => signInGrafana(token, { url: body?.url ?? options?.url }),
    mountConfig: (token, options, stateEntry) => ({
      transport: 'stdio',
      serverName: GRAFANA,
      command: options.command,
      args: options.args,
      env: { GRAFANA_URL: CONNECTOR_DEFS[GRAFANA].address(options, stateEntry), GRAFANA_SERVICE_ACCOUNT_TOKEN: token, ...options.env },
      failOnStartupError: true,
    }),
  },
  [GOOGLE_WORKSPACE]: {
    id: GOOGLE_WORKSPACE,
    name: 'Google Workspace',
    secret: GOOGLE_WORKSPACE_SECRET,
    purpose: 'Google Workspace connector',
    validate: () => {},
    signIn: async token => signInGoogleWorkspace(token),
    // A secret saved by an earlier version may still be a path to the file.
    mountConfig: (token, options, stateEntry, rt) => ({
      transport: 'stdio',
      serverName: 'google_workspace',
      command: options.command,
      args: options.args,
      env: { GOOGLE_APPLICATION_CREDENTIALS: token.startsWith('{') ? writeGoogleCredentials(rt.home, token) : token, ...options.env },
      failOnStartupError: true,
    }),
    forget: rt => rmSync(join(rt.home, GOOGLE_CREDENTIALS_FILE), { force: true }),
  },
}

export function install(rt) {
  const { ctx, state } = rt
  const isTest = Boolean(process.env.DSH_HARNESS)

  const getOptions = (id) => {
    if (rt.config[id] === false) return null
    if (isTest && rt.config[id] === undefined && id !== GITHUB) return null
    const defaults = DEFAULTS[id] ?? {}
    return { ...defaults, ...(typeof rt.config[id] === 'object' ? rt.config[id] : {}) }
  }

  const activeConnectors = () => Object.keys(CONNECTOR_DEFS)
    .filter(id => getOptions(id) !== null)
    .map(id => CONNECTOR_DEFS[id])

  const mounts = new Map()
  const statuses = new Map()
  let queue = Promise.resolve()
  let stopped = false

  const unmountOne = async (id) => {
    const fiber = mounts.get(id)?.fiber
    mounts.delete(id)
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
  }

  const unmountAll = async () => {
    const list = [...mounts.keys()]
    for (const id of list) await unmountOne(id)
  }

  const forget = (def) => {
    try {
      def.forget?.(rt)
    } catch (error) {
      rt.warn('ds-bot: %s connector could not remove its files: %s', def.name, error?.message ?? error)
    }
  }

  const reason = (error) => {
    const text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  async function reconcileOne(id, force) {
    const def = CONNECTOR_DEFS[id]
    if (!def) return
    const options = getOptions(id)
    if (options === null || stopped) {
      await unmountOne(id)
      statuses.set(id, { state: 'off' })
      return
    }
    const token = rt.secretValue(def.secret)
    const stateEntry = state.connectors?.[id]
    const current = mounts.get(id)
    const currentUrl = stateEntry?.url ?? null
    if (!force && current !== undefined && current.token === token && (current.url ?? null) === currentUrl) return
    await unmountOne(id)
    if (token === undefined) {
      forget(def)
      statuses.set(id, { state: 'off' })
      return
    }
    try {
      def.validate(options, stateEntry)
    } catch (err) {
      mounts.set(id, { token, url: currentUrl })
      statuses.set(id, { state: 'error', error: err.message })
      return
    }
    statuses.set(id, { state: 'connecting' })
    const loader = ctx.get?.('loader')
    if (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function') {
      mounts.set(id, { token, url: currentUrl })
      statuses.set(id, { state: 'error', error: 'This DSH cannot load connectors' })
      return
    }
    try {
      const exports = await loader.import(MCP_CLIENT)
      const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      const fiber = ctx.plugin(plugin, def.mountConfig(token, options, stateEntry, rt))
      mounts.set(id, { token, fiber, url: currentUrl })
      await fiber.await()
      if (mounts.get(id)?.fiber !== fiber) return
      statuses.set(id, { state: 'ready' })
    } catch (error) {
      await unmountOne(id)
      mounts.set(id, { token, url: currentUrl })
      statuses.set(id, { state: 'error', error: reason(error) })
      rt.warn('ds-bot: %s connector failed: %s', def.name, statuses.get(id).error)
    }
  }

  async function reconcile(force) {
    for (const def of activeConnectors()) {
      await reconcileOne(def.id, force)
    }
  }

  const sync = (force = false, id = null) => {
    queue = queue.then(() => (id ? reconcileOne(id, force) : reconcile(force))).catch(error => { rt.warn('ds-bot: connectors: %s', reason(error)) })
    return queue
  }

  const connectorsView = () => activeConnectors().map(def => {
    const status = statuses.get(def.id) ?? { state: 'off' }
    const hasSecret = rt.secretValue(def.secret) !== undefined
    const info = state.connectors?.[def.id]
    return {
      id: def.id,
      name: def.name,
      state: status.state,
      ...(status.error !== undefined ? { error: status.error } : {}),
      account: hasSecret ? info?.login ?? null : null,
      ...(info?.url ? { url: info.url } : {}),
    }
  })

  const known = id => {
    const def = CONNECTOR_DEFS[id]
    if (!def || getOptions(id) === null) throw new Error('No such connector')
    return def
  }

  const endpoints = {
    async 'connector-connect'(body) {
      const def = known(body.id)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('Paste a token first')
      const options = getOptions(body.id)
      def.validate(options, state.connectors?.[body.id], body)
      const url = def.address?.(options, state.connectors?.[body.id], body)
      await rt.loadSecrets()
      const kept = rt.secretValue(def.secret) !== undefined
      const { login, secret = token } = await def.signIn(token, options, body)
      await rt.secretEndpoint('secret-set', { name: def.secret, value: secret, purpose: def.purpose, ...(kept ? {} : { scope: [] }) })
      state.connectors = {
        ...state.connectors,
        [body.id]: { login, connectedAt: Date.now(), ...(url ? { url } : {}) },
      }
      await rt.save()
      await sync(false, body.id)
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      const def = known(body.id)
      await rt.loadSecrets()
      if (rt.secretValue(def.secret) !== undefined) await rt.secretEndpoint('secret-delete', { name: def.secret })
      forget(def)
      if (state.connectors?.[body.id] !== undefined) {
        delete state.connectors[body.id]
        await rt.save()
      }
      await sync(false, body.id)
      return connectorsView()
    },
    async 'connector-retry'(body) {
      known(body.id)
      await rt.loadSecrets()
      await sync(true, body.id)
      return connectorsView()
    },
  }

  const connectorEndpoint = (endpoint, body) => endpoints[endpoint](body ?? {})

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(() => sync())
    return () => {
      stopped = true
      void unmountAll()
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { void sync() } })
}
