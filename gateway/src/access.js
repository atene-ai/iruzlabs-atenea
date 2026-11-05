// What SLA says a staff member may do in Atenea: GET /api/atenea/me with the member's ID token.
// SLA answers 401 or 403 for a suspended account or someone who is not staff.

const FETCH_TIMEOUT_MS = 10_000
const AGENT_ROLES = new Set(['owner', 'editor', 'reader'])

export class AccessDenied extends Error {}
export class AccessUnavailable extends Error {}

const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

// Accepts `agents` as a { botId: role } map or as a list of { botId, role }; any other
// role is dropped rather than widened.
function agentRoles(agents) {
  const entries = Array.isArray(agents)
    ? agents.map(agent => [agent?.botId ?? agent?.id, agent?.role])
    : Object.entries(agents && typeof agents === 'object' ? agents : {})
  const roles = {}
  for (const [botId, role] of entries) {
    if (text(botId) && AGENT_ROLES.has(role)) roles[botId.trim()] = role
  }
  return roles
}

// The body is { staff: { id, email, displayName, role }, agents }; the staff fields may
// also sit at the top level.
export function parseAccess(body) {
  const staff = body?.staff && typeof body.staff === 'object' ? body.staff : body
  const id = text(staff?.id) ?? (typeof staff?.id === 'number' ? String(staff.id) : undefined)
  if (id === undefined) throw new AccessUnavailable('SLA sent no staff id')
  return {
    id,
    email: text(staff.email) ?? '',
    name: text(staff.displayName) ?? text(staff.name) ?? text(staff.email) ?? '',
    role: text(staff.role) ?? '',
    agents: agentRoles(body?.agents ?? staff.agents),
  }
}

export async function fetchAccess(slaUrl, idToken, fetch = globalThis.fetch) {
  let response
  try {
    response = await fetch(`${slaUrl}/api/atenea/me`, {
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new AccessUnavailable(`SLA is unreachable: ${error?.message ?? error}`)
  }
  if (response.status === 401 || response.status === 403) throw new AccessDenied(`SLA answered ${response.status}`)
  if (!response.ok) throw new AccessUnavailable(`SLA answered ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new AccessUnavailable('SLA sent no JSON')
  }
  return parseAccess(body)
}
