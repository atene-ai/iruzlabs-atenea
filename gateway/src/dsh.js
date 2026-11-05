// The gateway's own owner session at dsh web. dsh prints a launch URL whose token, sent once
// to GET /?token=, sets a signed owner cookie bound to the authority it was sent to. The
// gateway trades the token itself and keeps the cookie in memory; browsers never see either.
import http from 'node:http'
import { readFile } from 'node:fs/promises'

const REQUEST_TIMEOUT_MS = 10_000
// Renewed when this share of its lifetime is gone, well before dsh refuses it.
const RENEW_AT = 0.9
const DEFAULT_LIFETIME_MS = 24 * 3_600_000

export class DshUnavailable extends Error {}

export function launchToken(text) {
  const match = String(text ?? '').match(/[?&]token=([^&\s)]+)/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

function lifetimeMs(setCookie) {
  const maxAge = /;\s*max-age=(\d+)/i.exec(setCookie)
  if (maxAge) return Number(maxAge[1]) * 1000
  const expires = /;\s*expires=([^;]+)/i.exec(setCookie)
  const at = expires ? Date.parse(expires[1]) : NaN
  return Number.isFinite(at) ? at - Date.now() : DEFAULT_LIFETIME_MS
}

export function createDshLink({ upstream, launchUrl, launchUrlFile }, { now = Date.now, log = () => {} } = {}) {
  const target = new URL(upstream)
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const port = Number(target.port || 80)
  let current = null
  let pending = null

  function get(path) {
    return new Promise((resolve, reject) => {
      const request = http.get({ hostname, port, path, headers: { host: target.host }, timeout: REQUEST_TIMEOUT_MS, agent: false }, (response) => {
        response.resume()
        response.on('end', () => resolve(response))
        response.on('error', reject)
      })
      request.on('timeout', () => request.destroy(new Error('dsh web did not answer in time')))
      request.on('error', reject)
    })
  }

  async function readToken() {
    let text = launchUrl
    if (text === undefined) {
      try {
        text = await readFile(launchUrlFile, 'utf8')
      } catch (error) {
        throw new DshUnavailable(error?.code === 'ENOENT' ? 'dsh web has not written its launch URL yet' : 'cannot read the dsh launch URL file')
      }
    }
    const token = launchToken(text)
    if (token === undefined) throw new DshUnavailable('the dsh launch URL carries no token')
    return token
  }

  async function exchange() {
    const token = await readToken()
    let response
    try {
      response = await get(`/?token=${encodeURIComponent(token)}`)
    } catch (error) {
      throw new DshUnavailable(`dsh web is unreachable: ${error?.message ?? error}`)
    }
    const setCookies = [response.headers['set-cookie'] ?? []].flat()
    const owned = setCookies.filter(line => line.startsWith('dsh-'))
    const chosen = owned.length > 0 ? owned : setCookies
    if (response.statusCode < 300 || response.statusCode >= 400 || chosen.length === 0) {
      throw new DshUnavailable(`dsh web refused the launch token (HTTP ${response.statusCode})`)
    }
    const lifetime = Math.min(...chosen.map(lifetimeMs))
    current = { header: chosen.map(line => line.split(';', 1)[0]).join('; '), renewAt: now() + lifetime * RENEW_AT }
    log('gateway: dsh owner cookie acquired')
    return current.header
  }

  return {
    authority: target.host,
    origin: target.origin,
    hostname,
    port,

    async cookie() {
      if (current !== null && now() < current.renewAt) return current.header
      pending ??= exchange().finally(() => { pending = null })
      return pending
    },

    // dsh answered 401 to this cookie: dsh lost its owner key, or the cookie aged out.
    // Only the cookie that failed is dropped, so parallel failures trade the token once.
    invalidate(header) {
      if (current?.header === header) current = null
    },

    get ready() {
      return current !== null
    },

    async reachable() {
      try {
        await get('/')
        return true
      } catch {
        return false
      }
    },
  }
}
