// Cookie header parsing and Set-Cookie serialization, for the gateway's own cookies.

export function parseCookies(header) {
  const cookies = new Map()
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const name = part.slice(0, at).trim()
    // The first of two cookies with one name is the more specific one; keep it.
    if (!cookies.has(name)) cookies.set(name, part.slice(at + 1).trim())
  }
  return cookies
}

export function serializeCookie(name, value, { maxAge, path = '/', sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'Secure', `SameSite=${sameSite}`]
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
  return parts.join('; ')
}

export const clearCookie = (name, options = {}) => serializeCookie(name, '', { ...options, maxAge: 0 })
