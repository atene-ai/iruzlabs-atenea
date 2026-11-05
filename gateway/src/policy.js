// Which browser requests reach dsh web. Remote unary calls are POST /api/<namespace>/<method>,
// and dsh refuses a body whose method differs from the path, so the path is a sound place to
// filter them. Remote streams share one WebSocket (/api/remote.mux) that this gateway passes
// through unread; the owner-only features that use streams are switched off in dsh itself
// (docker/server.patch.yml). Lists follow dsh 0.2.0-rc.2; unknown namespaces are refused.
import { posix } from 'node:path'

// Namespaces the Atenea UI calls: Sessions and chat, Workspace navigation, jobs, goals,
// questions, feedback, commands, presets, model lists, uploads and read-only settings.
export const ALLOWED_NAMESPACES = new Set([
  'agentPresets', 'commands', 'credentials', 'fileReferences', 'fileUploads', 'goals', 'job',
  'llm', 'messageFeedback', 'permissionPresets', 'pluginInventory', 'session', 'sessionFeedback',
  'sessionReferenceResolver', 'settings', 'skills', 'subagents', 'userQuestions', 'workspace',
])

// Writers and host actions inside otherwise allowed namespaces. settings and credentials
// keep only their redacted reads (describe).
export const DENIED_ENDPOINTS = new Set([
  'settings/mutate', 'settings/replace', 'settings/update', 'settings/openSettingsDocument',
  'credentials/set', 'credentials/unset',
  'agentPresets/select',
  'session/openWorkspacePath',
])

const SEGMENT = /^[A-Za-z0-9_$.-]+$/
const READ = new Set(['GET', 'HEAD'])

const allow = { allow: true }
const deny = (status, reason) => ({ allow: false, status, reason })

// GET /api/file?path= serves any absolute path dsh can read; only the shared work folders.
function fileAllowed(searchParams, roots) {
  const paths = searchParams.getAll('path')
  if (paths.length !== 1) return false
  const path = paths[0]
  if (!path.startsWith('/') || path.includes('\0')) return false
  const normal = posix.normalize(path)
  return roots.some(root => normal.startsWith(`${root}/`))
}

function api(method, pathname, searchParams, { fileRoots }) {
  switch (pathname) {
    case '/api/bot':
      return method === 'POST' ? allow : deny(405, 'method')
    case '/api/bot/feed':
      return method === 'GET' ? allow : deny(405, 'method')
    case '/api/file':
      if (!READ.has(method)) return deny(405, 'method')
      return fileAllowed(searchParams, fileRoots) ? allow : deny(403, 'file outside the work folders')
    case '/api/session.export':
      return READ.has(method) ? allow : deny(405, 'method')
    case '/api/remote.mux':
      return deny(400, 'WebSocket only')
  }
  const segments = pathname.slice('/api/'.length).split('/')
  if (segments.length !== 2 || !segments.every(segment => SEGMENT.test(segment))) return deny(404, 'unknown route')
  const endpoint = segments.join('/')
  if (!ALLOWED_NAMESPACES.has(segments[0]) || DENIED_ENDPOINTS.has(endpoint)) return deny(403, `blocked endpoint ${endpoint}`)
  return method === 'POST' ? allow : deny(405, 'method')
}

export function decide({ method, pathname, searchParams, upgrade = false }, options) {
  if (upgrade) return method === 'GET' && pathname === '/api/remote.mux' ? allow : deny(404, 'unknown WebSocket')
  if (pathname === '/api' || pathname.startsWith('/api/')) return api(method, pathname, searchParams, options)
  // /connect trades a launch token for an API cookie; the others start host programs or
  // finish dsh's own account sign-in.
  if (pathname === '/connect' || pathname === '/oauth/callback' || pathname.startsWith('/open-in-app/')) return deny(404, 'blocked route')
  return READ.has(method) ? allow : deny(405, 'method')
}
