// SLA: Iruz Labs' ERP keeps the staff directory and who owns or shares each agent.
// The host calls it on behalf of the person whose request it serves, with that person's
// own token from the gateway; the browser never calls SLA itself.
const TIMEOUT_MS = 10_000
const MESSAGE_MAX = 200

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const agentPath = botId => `api/atenea/agents/${encodeURIComponent(botId)}`

export function install(rt) {
  async function request(method, path, body) {
    // Read before the first await, so a fire-and-forget call keeps the caller's token.
    const token = rt.requestContext?.()?.slaToken
    const base = rt.multiuserSettings?.slaUrl
    if (!base) throw refused('SLA is not configured on this server')
    if (token === undefined) throw Object.assign(new Error('Sign in to Atenea first'), { code: 'bot/auth-required' })
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`)
    let response
    try {
      response = await (rt.slaFetch ?? fetch)(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw refused(`SLA did not answer: ${String(error?.message ?? error).slice(0, MESSAGE_MAX)}`)
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      const said = typeof detail?.message === 'string' ? detail.message : typeof detail?.error === 'string' ? detail.error : ''
      // `status` and `reason` (SLA's error code) let a caller say what to do about it.
      throw Object.assign(refused(`SLA answered ${response.status}${said ? `: ${said.slice(0, MESSAGE_MAX)}` : ''}`), { status: response.status, reason: said.slice(0, MESSAGE_MAX) })
    }
    if (response.status === 204) return undefined
    return response.json().catch(() => undefined)
  }

  const sla = {
    registerAgent: (botId, name) => request('PUT', agentPath(botId), { name }),
    deleteAgent: botId => request('DELETE', agentPath(botId)),
    listShares: botId => request('GET', `${agentPath(botId)}/shares`),
    putShare: (botId, share) => request('PUT', `${agentPath(botId)}/shares`, share),
    deleteShare: (botId, staffUserId) => request('DELETE', `${agentPath(botId)}/shares/${encodeURIComponent(staffUserId)}`),
    searchStaff: q => request('GET', `api/atenea/staff?${new URLSearchParams({ q })}`),
    // The person's products and customer accounts with their level, and a short grant
    // to act in one subaccount (workspace) of an account in the CRM (crm.js).
    me: () => request('GET', 'api/atenea/me'),
    grant: ({ productAccountId, workspaceId, mode, reason }) => request('POST', 'api/atenea/grants', { productAccountId, workspaceId, mode, reason }),
    // Never blocks or fails the action it records: a lost audit line is only logged.
    audit(entry) {
      void request('POST', 'api/atenea/audit', entry)
        .catch(error => rt.warn?.('ds-bot: audit of %s %s not written: %s', entry.action, entry.targetId ?? '', error?.message ?? error))
    },
  }

  Object.assign(rt, { sla })
}
