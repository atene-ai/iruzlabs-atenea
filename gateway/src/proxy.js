// Forwards an allowed browser request to dsh web as the gateway's own owner session: the
// browser's cookies and credentials stay behind, Host and Origin name dsh's own authority
// (which dsh trusts), and the identity headers are the gateway's alone.
import http from 'node:http'
import { createFrameReader, maskedFrame } from './websocket.js'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
// Credentials and addressing the browser sent to the gateway, never to dsh. sec-fetch-*
// describe the browser's view of the gateway's origin, which the gateway checked itself.
const DROPPED = new Set(['cookie', 'authorization', 'host', 'origin', 'forwarded', 'x-real-ip', 'expect'])
const DROPPED_PREFIXES = ['x-atenea-', 'x-forwarded-', 'sec-fetch-']
// A body this small is read first, so a request dsh refuses for a stale cookie can be sent again.
export const REPLAY_LIMIT = 1024 * 1024

function connectionTokens(headers) {
  return new Set(String(headers.connection ?? '').toLowerCase().split(',').map(token => token.trim()).filter(Boolean))
}

export function upstreamHeaders(client, { authority, origin, cookie, identity, slaToken }) {
  const named = connectionTokens(client)
  const headers = {}
  for (const [given, value] of Object.entries(client)) {
    const name = given.toLowerCase()
    if (HOP_BY_HOP.has(name) || DROPPED.has(name) || named.has(name)) continue
    if (DROPPED_PREFIXES.some(prefix => name.startsWith(prefix))) continue
    headers[name] = value
  }
  headers.host = authority
  headers.cookie = cookie
  if (client.origin !== undefined) headers.origin = origin
  headers['x-atenea-identity'] = identity
  headers['x-atenea-sla-token'] = slaToken
  return headers
}

// dsh's own cookies never reach the browser.
export function downstreamHeaders(upstream) {
  const named = connectionTokens(upstream)
  const headers = {}
  for (const [name, value] of Object.entries(upstream)) {
    if (HOP_BY_HOP.has(name) || named.has(name) || name === 'set-cookie') continue
    headers[name] = value
  }
  return headers
}

// The whole request body, refused with code BODY_TOO_LARGE past `limit` bytes. A refused
// body is read to its end and dropped first: a client still sending would otherwise get
// a reset instead of the refusal.
export function readBody(req, limit = REPLAY_LIMIT) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.once('end', () => reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' })))
      req.resume()
    }
    req.on('error', reject)
    req.on('close', () => {
      if (!req.complete) reject(new Error('request aborted'))
    })
    if (Number(req.headers['content-length']) > limit) return tooLarge()
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) return tooLarge()
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// Empty for bodiless methods, a Buffer when it can be replayed, null when it must stream.
async function bodyOf(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Buffer.alloc(0)
  const length = Number(req.headers['content-length'])
  if (req.headers['transfer-encoding'] === undefined && Number.isInteger(length) && length <= REPLAY_LIMIT) return readBody(req)
  return null
}

// `body` writes the request; it is kept apart from the options, which reach the socket.
function send(link, agent, options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: link.hostname, port: link.port, agent, ...options })
    request.once('response', response => resolve({ request, response }))
    request.once('upgrade', (response, socket, head) => resolve({ request, response, socket, head }))
    request.once('error', reject)
    body(request)
  })
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

const isJson = headers => String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() === 'application/json'

// `body`: the request body when the caller already read it. `transform(buffer)`: rewrites
// a successful JSON answer before the browser gets it; any other successful answer is
// refused, so nothing passes unfiltered. `onStatus(code)`: told dsh's final status.
export async function forwardHttp(req, res, { link, agent, path, headersFor, extraHeaders = {}, body: given, transform, onStatus }) {
  let pending = null
  res.on('close', () => {
    if (!res.writableFinished) pending?.destroy()
  })
  const body = given ?? await bodyOf(req)
  for (let attempt = 0; ; attempt += 1) {
    const cookie = await link.cookie()
    const headers = headersFor(cookie)
    if (body !== null) {
      delete headers['transfer-encoding']
      if (body.length > 0 || req.headers['content-length'] !== undefined) headers['content-length'] = String(body.length)
    }
    // A compressed answer could not be read to filter it.
    if (transform !== undefined) delete headers['accept-encoding']
    const { response } = await send(link, agent, { method: req.method, path, headers }, (request) => {
      pending = request
      if (body === null) req.pipe(request)
      else request.end(body)
    })
    if (response.statusCode === 401) {
      link.invalidate(cookie)
      if (attempt === 0 && body !== null) {
        response.resume()
        continue
      }
    }
    onStatus?.(response.statusCode)
    if (res.destroyed) {
      response.destroy()
      return
    }
    if (transform !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
      if (!isJson(response.headers) || response.headers['content-encoding'] !== undefined) {
        response.destroy()
        throw new Error(`unfilterable answer to ${path}`)
      }
      const filtered = await transform(await readAll(response))
      const headers = { ...downstreamHeaders(response.headers), ...extraHeaders, 'content-length': String(filtered.length) }
      delete headers['transfer-encoding']
      res.writeHead(response.statusCode, headers)
      res.end(filtered)
      return
    }
    res.writeHead(response.statusCode, { ...downstreamHeaders(response.headers), ...extraHeaders })
    response.pipe(res)
    response.on('error', () => res.destroy())
    return
  }
}

function refuse(socket, status, reason) {
  if (!socket.writable) return socket.destroy()
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function switchingHead(response) {
  const lines = ['HTTP/1.1 101 Switching Protocols']
  const raw = response.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== 'set-cookie') lines.push(`${raw[i]}: ${raw[i + 1]}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

// Browser-to-dsh WebSocket messages through `decide({ opcode, data })`, which gives the
// payload to send on (masked again) or null to close both sides. Control frames pass as
// sent, in order with the messages around them.
const QUEUE_HIGH = 64
const QUEUE_LOW = 16

function relayDecided(socket, upstream, head, decide) {
  const reader = createFrameReader()
  let chain = Promise.resolve()
  let queued = 0
  const close = () => {
    socket.destroy()
    upstream.destroy()
  }
  const resume = () => {
    if (queued <= QUEUE_LOW && !upstream.writableNeedDrain && socket.isPaused()) socket.resume()
  }
  upstream.on('drain', resume)
  const send = (bytes) => {
    if (upstream.destroyed) return
    if (!upstream.write(bytes)) socket.pause()
  }
  const take = (chunk) => {
    let events
    try {
      events = reader.push(chunk)
    } catch {
      return close()
    }
    for (const event of events) {
      queued += 1
      if (queued > QUEUE_HIGH) socket.pause()
      chain = chain
        .then(async () => {
          if (socket.destroyed || upstream.destroyed) return
          if (event.control !== undefined) return send(event.control)
          const payload = await decide(event)
          if (payload === null) return close()
          send(maskedFrame(event.opcode, payload))
        })
        .catch(close)
        .finally(() => {
          queued -= 1
          resume()
        })
    }
  }
  socket.on('data', take)
  if (head.length > 0) take(head)
}

export async function forwardUpgrade(req, socket, head, { link, path, headersFor, decide }) {
  for (let attempt = 0; ; attempt += 1) {
    const cookie = await link.cookie()
    const headers = { ...headersFor(cookie), connection: 'Upgrade', upgrade: req.headers.upgrade }
    // A compressed frame could not be read, so no extension is offered.
    if (decide !== undefined) delete headers['sec-websocket-extensions']
    const { response, socket: upstream, head: upstreamHead } = await send(link, false, { method: 'GET', path, headers }, request => request.end())
    if (upstream === undefined) {
      response.resume()
      if (response.statusCode === 401) {
        link.invalidate(cookie)
        if (attempt === 0) continue
      }
      refuse(socket, response.statusCode, response.statusMessage || 'Refused')
      return
    }
    if (socket.destroyed) {
      upstream.destroy()
      return
    }
    if (decide !== undefined && response.headers['sec-websocket-extensions'] !== undefined) {
      upstream.destroy()
      refuse(socket, 502, 'Bad Gateway')
      return
    }
    socket.setNoDelay(true)
    upstream.setNoDelay(true)
    socket.write(switchingHead(response))
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    for (const end of [socket, upstream]) {
      end.on('error', close)
      end.on('close', close)
    }
    upstream.pipe(socket)
    if (decide !== undefined) relayDecided(socket, upstream, head, decide)
    else {
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
    }
    return
  }
}

export { refuse }
