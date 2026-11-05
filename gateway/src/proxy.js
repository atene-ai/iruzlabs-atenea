// Forwards an allowed browser request to dsh web as the gateway's own owner session: the
// browser's cookies and credentials stay behind, Host and Origin name dsh's own authority
// (which dsh trusts), and the identity headers are the gateway's alone.
import http from 'node:http'

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > REPLAY_LIMIT) {
        req.destroy()
        reject(new Error('request body larger than its Content-Length'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('close', () => {
      if (!req.complete) reject(new Error('request aborted'))
    })
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

export async function forwardHttp(req, res, { link, agent, path, headersFor, extraHeaders = {} }) {
  let pending = null
  res.on('close', () => {
    if (!res.writableFinished) pending?.destroy()
  })
  const body = await bodyOf(req)
  for (let attempt = 0; ; attempt += 1) {
    const cookie = await link.cookie()
    const headers = headersFor(cookie)
    if (body !== null) {
      delete headers['transfer-encoding']
      if (body.length > 0 || req.headers['content-length'] !== undefined) headers['content-length'] = String(body.length)
    }
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
    if (res.destroyed) {
      response.destroy()
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

export async function forwardUpgrade(req, socket, head, { link, path, headersFor }) {
  for (let attempt = 0; ; attempt += 1) {
    const cookie = await link.cookie()
    const headers = { ...headersFor(cookie), connection: 'Upgrade', upgrade: req.headers.upgrade }
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
    socket.setNoDelay(true)
    upstream.setNoDelay(true)
    socket.write(switchingHead(response))
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstream.write(head)
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    for (const end of [socket, upstream]) {
      end.on('error', close)
      end.on('close', close)
    }
    upstream.pipe(socket)
    socket.pipe(upstream)
    return
  }
}

export { refuse }
