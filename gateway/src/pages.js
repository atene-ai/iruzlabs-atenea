// The few pages the gateway draws itself. Staff read Spanish; the pages load nothing.

const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

const layout = (title, body) => `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atenea · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f6f8; --card: #ffffff; --ink: #18202b; --muted: #5b6573; --line: #dde1e7; --accent: #2f5fd0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a2029; --ink: #e8ecf2; --muted: #9aa4b2; --line: #2a323e; --accent: #7aa2ff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 1rem; padding: 2rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
  p { margin: 0 0 1rem; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`

export const noAccessPage = () => layout('Tu cuenta no tiene acceso a Atenea', `
<p>Tu cuenta está suspendida o no forma parte del personal de Iruz Labs con acceso a Atenea.</p>
<p>Si crees que es un error, pide acceso a un administrador.</p>
<p><a href="/auth/logout">Entrar con otra cuenta</a></p>`)

export const errorPage = message => layout('No se pudo iniciar sesión', `
<p>${escapeHtml(message)}</p>
<p><a href="/auth/login">Intentar de nuevo</a></p>`)

export const unavailablePage = () => layout('Atenea no está disponible', `
<p>No pudimos comprobar tu acceso o Atenea no responde en este momento.</p>
<p><a href="/">Intentar de nuevo</a></p>`)

export function sendPage(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(res.req?.method === 'HEAD' ? undefined : html)
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}
