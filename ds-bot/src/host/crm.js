// CRM: Bots work in the company CRM (Sales OS) for the staff member who asked them, on a
// shared Atenea server. Two ways in, each behind that person's identity (identity.js):
// - a staff grant: a short JWS from SLA for one customer account SLA assigns to them, at
//   their level there (read or operate);
// - their own CRM user, linked once through the CRM's sign-in (crm-link.js), so the
//   CRM's own rules apply and it records them as the author.
// Who a Bot acts for in a turn, and what a turn no person started may do, is in the
// design note (docs/plans/2026-11-05-crm-agent-connector.md). The tools are in
// crm-tools.js. Everything here is inert unless ATENEA_MULTIUSER=1.
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REPLY_KIND, ROUTE } from './constants.js'
import { within } from './folders.js'
import * as link from './crm-link.js'
import { install as installTools } from './crm-tools.js'

export const CRM_CALLBACK_ROUTE = `${ROUTE}/crm/callback`
export const UNATTENDED_MODES = ['off', 'read', 'operate']
const DEFAULT_API = 'https://api.iruzlabs.com'
const CRM_TIMEOUT_MS = 20_000
const AUTH_TIMEOUT_MS = 10_000
// SLA's account list changes rarely; a Bot's calls in one task reuse it.
const ACCOUNTS_TTL_MS = 60_000
// A grant (at most 15 minutes) or an ID token is taken anew this long before it runs out.
const GRANT_MARGIN_MS = 60_000
const GRANT_MAX_MS = 15 * 60_000
const ID_TOKEN_MARGIN_MS = 60_000
const PENDING_LINK_MS = 10 * 60_000
const PENDING_LINKS_MAX = 200
// The card answer that opens a turn names who answered it for this long.
const ANSWER_MS = 10 * 60_000
// The window claims a composer message for its author right after it is sent; a tool
// call early in the turn waits this long for the claim.
const AUTHOR_WAIT_MS = 3000
const IMPORT_MAX_BYTES = 10 * 1024 * 1024
const SAID_MAX = 200

const refusal = message => Object.assign(new Error(message), { code: 'bot/refused' })
const str = value => (typeof value === 'string' ? value : '')
const number = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Plugin config (`crm: {…}`) wins over the environment, as in identity.js. The Cognito
// names are the CRM web app's own, so their values can be copied from it as they are.
export function crmSettings(config = {}, env = process.env) {
  const crm = config.crm ?? {}
  const userPoolId = crm.userPoolId ?? env.PUBLIC_AWS_COGNITO_USER_POOL_ID
  return {
    apiUrl: String(crm.apiUrl ?? env.ATENEA_CRM_API_URL ?? DEFAULT_API).replace(/\/+$/, ''),
    // SLA's customer accounts of the CRM; accounts of other products are not the CRM's.
    // SLA records the CRM (Sales OS) accounts under the source system "sales-os".
    sourceSystem: crm.sourceSystem ?? env.ATENEA_CRM_SOURCE_SYSTEM ?? 'sales-os',
    userPoolId,
    clientId: crm.clientId ?? env.PUBLIC_AWS_COGNITO_USER_POOL_CLIENT_ID,
    // A pool id starts with its region (`<region>_<id>`).
    region: crm.region ?? env.PUBLIC_AWS_REGION ?? (typeof userPoolId === 'string' && userPoolId.includes('_') ? userPoolId.split('_')[0] : undefined),
    domain: crm.cognitoDomain ?? env.ATENEA_CRM_COGNITO_DOMAIN,
    redirectUri: crm.redirectUri ?? env.ATENEA_CRM_REDIRECT_URI,
    tokenKey: crm.tokenKey ?? env.ATENEA_CRM_TOKEN_KEY,
    writesPerMinute: number(crm.writesPerMinute ?? env.ATENEA_CRM_WRITES_PER_MINUTE, 30),
    // The CRM sends a message before it stores who sent it, and cannot store a staff
    // member yet: a staff send would reach the lead and then fail. Set once it can.
    staffAuthors: crm.staffAuthors ?? env.ATENEA_CRM_STAFF_AUTHORS === '1',
  }
}

// The CRM refuses a staff grant in Spanish; what each refusal means for the person.
const GRANT_REFUSALS = [
  [/caducad/i, 'expired'],
  [/solo lectura/i, 'readOnly'],
  [/no est[aá] disponible con una concesi[oó]n/i, 'staffRoute'],
  [/no cubre esa subcuenta/i, 'subaccount'],
]

export function crmFailureText({ status, said = '' }, { via, write = false, author = false } = {}) {
  const grant = via === 'grant'
  const detail = said ? `: ${said}` : ''
  const kind = grant ? GRANT_REFUSALS.find(([pattern]) => pattern.test(said))?.[1] : undefined
  if (kind === 'readOnly') return 'The CRM refused this change: the staff grant only allows reading.'
  if (kind === 'staffRoute') return 'The CRM keeps this action for the account\'s own users, so a staff grant cannot do it. A user of that account has to do it, or use your own linked CRM account if you have a user there.'
  if (kind === 'subaccount') return 'The CRM refused: that record belongs to another subaccount than the account you named.'
  if (kind === 'expired') return 'The CRM says the staff grant expired. Try again.'
  if (status === 401) return grant ? `The CRM did not accept the staff grant${detail}. The grant keys may not be set up in the CRM yet.` : 'The CRM did not accept your linked account. Link it again in Settings → Connectors → CRM.'
  if (status === 403) return grant ? `The CRM refused this for a staff grant${detail}.` : `The CRM refused: your CRM user may not do this in that account${detail}.`
  if (status === 404) return `Not found in that account${detail}.`
  if (status === 429) return 'The CRM is limiting requests right now. Wait a minute and try again.'
  if (status >= 500 && grant && write && author) {
    return 'The CRM could not save this change because it records who made it, and it cannot record a staff member yet (a known CRM limit for staff grants: lead imports, notes, flows and orders). Link your own CRM user in Settings → Connectors → CRM to do this, or ask a user of that account.'
  }
  if (status >= 500) return `The CRM failed (${status})${detail}.${grant && write ? ' If this change records who made it, a staff grant cannot do it yet.' : ''}`
  return `The CRM answered ${status}${detail}.`
}

// Why SLA gave no grant, for the person.
function grantFailureText(error, account, mode) {
  const reason = str(error?.reason)
  if (reason === 'account_not_assigned' || reason === 'product_account_not_found') return `SLA no longer assigns ${account.name} to you, so nothing was done there.`
  if (reason === 'insufficient_access_level') return `Your SLA level on ${account.name} only allows reading, so this change was not made.`
  if (reason === 'grant_signing_unavailable') return 'SLA cannot sign CRM grants right now (no signing key is set up), so nothing was done.'
  if (error?.status === 401) return 'SLA did not accept your Atenea session. Open Atenea again and ask once more.'
  return `SLA gave no ${mode} grant for ${account.name}: ${error?.message ?? error}`
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
// The page the CRM's sign-in comes back to: plain text, no script, nothing to leak.
function callbackPage(status, title, text) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title></head><body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } })
}

const listOf = value => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.items) ? value.items : [])

export function install(rt) {
  if (!rt.multiuser) {
    rt.crmEndpoint = async () => { throw Object.assign(new Error('The CRM tools are only available on a shared Atenea server'), { code: 'bot/unavailable' }) }
    return
  }
  const { ctx, state } = rt
  const settings = crmSettings(rt.config ?? {})
  let tokenKey
  let keyProblem
  try {
    tokenKey = link.parseTokenKey(settings.tokenKey)
  } catch (error) {
    keyProblem = error.message
  }
  const links = link.createLinkStore({ path: join(rt.home, 'crm-links.json'), key: tokenKey, warn: (...args) => rt.warn?.(...args) })
  const fetchCrm = (url, init) => (rt.crmFetch ?? fetch)(url, init)

  const missingForLink = () => [
    settings.domain ? undefined : 'ATENEA_CRM_COGNITO_DOMAIN (the CRM pool\'s Hosted UI domain)',
    settings.clientId ? undefined : 'PUBLIC_AWS_COGNITO_USER_POOL_CLIENT_ID',
    settings.redirectUri ? undefined : 'ATENEA_CRM_REDIRECT_URI',
    tokenKey ? undefined : keyProblem ?? 'ATENEA_CRM_TOKEN_KEY',
  ].filter(Boolean)
  const linkGap = () => {
    const missing = missingForLink()
    return missing.length === 0 ? undefined : `Linking your own CRM account is not set up on this server. Missing: ${missing.join(', ')}.`
  }

  // ---------------------------------------------------------------------------
  // Who a Bot acts for. In its own chat: the person whose message (or card answer)
  // opened the running turn. In a group: the one person who wrote in the running round.
  // Any other turn (a Bot's message, a scheduled task, a restart) acts for the Bot's
  // owner, and only as far as the owner allowed (`state.multiuser.crm.unattended`).

  /** @type {Map<string, {turn:number, kind?:string, rpcId?:string, person?:string}>} */
  const openers = new Map()
  /** @type {Map<string, {id:string, at:number}>} */
  const answerers = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || !rt.chatOwners.has(id)) return
    if (event.type === 'turn/start') {
      openers.set(id, { turn: event.data?.turn })
      return
    }
    if (event.type !== 'user/message') return
    const entry = openers.get(id)
    if (entry === undefined || entry.kind !== undefined) return
    const source = event.data?.source
    entry.kind = String(source?.kind ?? 'unknown')
    if (entry.kind === 'user' && typeof source.rpcId === 'string') entry.rpcId = source.rpcId
    if (entry.kind === REPLY_KIND) {
      const answer = answerers.get(id)
      answerers.delete(id)
      if (answer !== undefined && Date.now() - answer.at < ANSWER_MS) entry.person = answer.id
    }
  })
  // A question or view card's answer goes in without a request id of its own (channel.js).
  rt.noteCardAnswer = (sessionId, identity) => {
    if (typeof sessionId === 'string' && identity !== undefined) answerers.set(sessionId, { id: identity.id, at: Date.now() })
  }

  const unknownAuthor = 'I could not tell who sent the message that started this turn, so I will not act in the CRM for anyone. Messages sent from the Atenea window carry their author; ask again from there.'
  async function authorWithin(rpcId, ms) {
    const until = Date.now() + ms
    let author = rt.authorOf(rpcId)
    while (author === undefined && Date.now() < until) {
      await new Promise(done => setTimeout(done, 100))
      author = rt.authorOf(rpcId)
    }
    return author
  }

  // `{ personId }` when a person started the running turn, `{ refusal }` when someone
  // did but who is unclear, undefined when no person did.
  async function askedBy(sessionId) {
    if (rt.chatOwners.has(sessionId)) {
      const entry = openers.get(sessionId)
      if (entry === undefined || entry.turn !== rt.live?.get(sessionId)?.turn) return undefined
      if (entry.kind === 'user') {
        const author = entry.rpcId === undefined ? undefined : await authorWithin(entry.rpcId, rt.config?.crm?.authorWaitMs ?? AUTHOR_WAIT_MS)
        return author === undefined ? { refusal: unknownAuthor } : { personId: author.id }
      }
      if (entry.kind === REPLY_KIND && entry.person !== undefined) return { personId: entry.person }
      return undefined
    }
    const group = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(group?.roomId)
    const round = room === undefined ? undefined : [...(rt.roomProgress?.values() ?? [])].find(item => item.roomId === room.id)
    if (round === undefined) return undefined
    const lines = (room.log ?? []).filter(line => line.seq >= round.startSeq && line.who === 'User' && line.kind === undefined && line.botId === undefined)
    if (lines.length === 0) return undefined
    if (lines.some(line => typeof line.authorId !== 'string' || line.authorId === '')) return { refusal: unknownAuthor }
    if (new Set(lines.map(line => line.authorId)).size > 1) return { refusal: 'Several people wrote in this round of the group chat, so it is not clear whom to act for in the CRM. Ask again in one message once the round has ended.' }
    return { personId: lines[0].authorId }
  }

  const ownerOf = botId => str(state.multiuser?.registered?.[botId]?.by) || undefined
  const unattendedOf = (botId) => {
    const allowed = state.multiuser?.crm?.unattended?.[botId]
    return allowed !== undefined && allowed.by === ownerOf(botId) && (allowed.mode === 'read' || allowed.mode === 'operate') ? allowed.mode : 'off'
  }

  // What a CRM call in this tool call acts as: `{ person, slaToken, how, cap, bot, sessionId }`.
  // Never the request context the call may have inherited: only the turn decides.
  async function actingFor(exec) {
    const sessionId = exec.agent?.id
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (bot === undefined || !rt.isBotSession(sessionId)) throw refusal('Only Bots on the team can use the CRM tools.')
    const asked = await askedBy(sessionId)
    if (asked?.refusal !== undefined) throw refusal(asked.refusal)
    let personId = asked?.personId
    let how = 'asked'
    let cap = 'operate'
    if (personId === undefined) {
      how = 'unattended'
      cap = unattendedOf(bot.id)
      personId = ownerOf(bot.id)
      if (personId === undefined || cap === 'off') {
        throw refusal(`No person started this turn (it came from another Bot, a scheduled task or a restart), and ${bot.name}'s owner has not let it use the CRM on its own. Ask ${bot.name} in its chat, or its owner can allow it in Settings → Connectors → CRM.`)
      }
    }
    const kept = rt.keptContext(personId)
    if (kept === undefined || kept.expired) {
      const who = kept?.identity?.name
      throw refusal(how === 'asked'
        ? `The Atenea session of ${who ?? 'the person who asked'} has expired on this server, so ${bot.name} cannot act in the CRM for them. Open Atenea again (any page renews it) and ask once more.`
        : `${bot.name} acts for its owner${who ? ` (${who})` : ''} in turns no person started, and their Atenea session on this server has expired. It can use the CRM on its own again once they open Atenea.`)
    }
    const room = rt.groupOwners.get(sessionId)
    const writes = rt.runAs({ identity: kept.identity }, () => (room !== undefined ? rt.access.writes({ roomId: room.roomId }) : rt.access.writes({ botId: bot.id })))
    if (!writes) throw refusal(`${kept.identity.name} may not work with ${room !== undefined ? 'every member of this group chat' : bot.name} any more, so nothing is done in the CRM for them.`)
    return { person: kept.identity, slaToken: kept.slaToken, how, cap, bot, sessionId }
  }

  const asPerson = (acting, run) => rt.runAs({ identity: acting.person, slaToken: acting.slaToken }, run)

  // ---------------------------------------------------------------------------
  // Accounts: the customer accounts SLA assigns to the person, and the subaccounts of
  // their own linked CRM user.

  /** @type {Map<string, {at:number, value?:any[], promise?:Promise<any[]>}>} */
  const slaCache = new Map()
  const ownCache = new Map()
  const cached = (cache, key, load) => {
    const held = cache.get(key)
    if (held?.promise !== undefined) return held.promise
    if (held !== undefined && Date.now() - held.at < ACCOUNTS_TTL_MS) return Promise.resolve(held.value)
    const promise = load().then((value) => {
      cache.set(key, { at: Date.now(), value })
      return value
    }, (error) => {
      cache.delete(key)
      throw error
    })
    cache.set(key, { at: Date.now(), promise })
    return promise
  }

  // SLA assigns CRM accounts and lists each one's subaccounts as workspaces; the CRM
  // answers per subaccount, so each workspace is one account here and its grant names it.
  // An SLA without workspaces lists none rather than send an account id as a subaccount.
  const slaAccounts = acting => cached(slaCache, acting.person.id, async () => {
    const me = await asPerson(acting, () => rt.sla.me())
    return (Array.isArray(me?.accounts) ? me.accounts : [])
      .filter(entry => entry?.sourceSystem === settings.sourceSystem && str(entry.productAccountId) !== '' && Array.isArray(entry.workspaces))
      .flatMap((entry) => {
        const account = str(entry.name).trim().slice(0, 120) || entry.productAccountId
        const level = entry.accessLevel === 'operator' ? 'operate' : 'read'
        return entry.workspaces
          .filter(workspace => str(workspace?.workspaceId) !== '' && str(workspace?.externalId) !== '')
          .map(workspace => ({
            ref: `sla:${entry.productAccountId}:${workspace.workspaceId}`,
            via: 'grant',
            productAccountId: entry.productAccountId,
            workspaceId: workspace.workspaceId,
            subaccountId: workspace.externalId,
            accountName: account,
            name: `${account} · ${str(workspace.name).trim().slice(0, 120) || workspace.externalId}`,
            level,
          }))
      })
  })

  const ownAccounts = acting => cached(ownCache, acting.person.id, async () => {
    const { body } = await crmFetch(acting, { via: 'own', name: 'your CRM user' }, { path: '/api/subaccounts/v1' })
    return listOf(body).filter(entry => str(entry?.id) !== '').map(entry => ({
      ref: `own:${entry.id}`,
      via: 'own',
      subaccountId: entry.id,
      name: str(entry.name).trim().slice(0, 120) || entry.id,
      level: 'operate',
    }))
  })

  async function accountsOf(acting) {
    const problems = []
    const sla = await slaAccounts(acting).catch((error) => { problems.push(`SLA: ${error?.message ?? error}`); return [] })
    const own = links.has(acting.person.id) ? await ownAccounts(acting).catch((error) => { problems.push(`Your CRM account: ${error?.message ?? error}`); return [] }) : []
    return { accounts: [...sla, ...own], problems }
  }

  // The account a tool call names: a ref from crm_list_accounts, an id, or an exact name.
  // `problems` say why a source of accounts could not be read.
  function pickAccount(accounts, wanted, problems = []) {
    const ref = str(wanted).trim()
    if (ref === '') throw refusal('Name the account to act in (a ref from crm_list_accounts).')
    const exact = accounts.find(account => account.ref === ref)
    if (exact !== undefined) return exact
    const lower = ref.toLowerCase()
    // An SLA account's own name names it while it has one subaccount; with more, pick one.
    const matches = accounts.filter(account => account.productAccountId === ref || account.subaccountId === ref || account.name.toLowerCase() === lower || account.accountName?.toLowerCase() === lower)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw refusal(`"${ref}" names several accounts: ${matches.map(account => `${account.name} (${account.ref})`).join(', ')}. Use one ref.`)
    const known = accounts.map(account => `${account.name} (${account.ref})`).join(', ')
    const unread = problems.length > 0 ? ` Could not read: ${problems.join(' ')}` : ''
    throw refusal(`No CRM account "${ref}" among the ones you can use${known ? `: ${known}` : ''}. Use crm_list_accounts.${unread}`)
  }

  const modeOf = (acting, account) => (acting.cap === 'read' || account.level === 'read' ? 'read' : 'operate')

  // ---------------------------------------------------------------------------
  // Staff grants, one per person, account and mode, kept until shortly before they end.

  /** @type {Map<string, {grant?:string, until?:number, promise?:Promise<any>}>} */
  const grants = new Map()
  const grantKey = (acting, account, mode) => `${acting.person.id}\n${account.productAccountId}\n${account.workspaceId}\n${mode}`
  function grantFor(acting, account, mode, reason) {
    const key = grantKey(acting, account, mode)
    const held = grants.get(key)
    if (held?.promise !== undefined) return held.promise
    if (held !== undefined && held.until - GRANT_MARGIN_MS > Date.now()) return Promise.resolve(held)
    const promise = (async () => {
      let answer
      try {
        answer = await asPerson(acting, () => rt.sla.grant({ productAccountId: account.productAccountId, workspaceId: account.workspaceId, mode, reason }))
      } catch (error) {
        if (error?.status === 403) slaCache.delete(acting.person.id)
        throw refusal(error?.code === 'bot/refused' && error.status === undefined ? error.message : grantFailureText(error, account, mode))
      }
      const until = Math.min(Date.parse(answer?.expiresAt), Date.now() + GRANT_MAX_MS)
      if (typeof answer?.grant !== 'string' || answer.grant === '' || !Number.isFinite(until)) throw refusal('SLA answered without a usable grant, so nothing was done.')
      const entry = { grant: answer.grant, until }
      grants.set(key, entry)
      return entry
    })().catch((error) => {
      grants.delete(key)
      throw error
    })
    grants.set(key, { promise })
    return promise
  }

  // ---------------------------------------------------------------------------
  // The person's own CRM user: an ID token from their refresh token, kept until it ends.

  /** @type {Map<string, {token?:string, until?:number, promise?:Promise<string>}>} */
  const idTokens = new Map()
  async function tokenRequest(form) {
    let response
    try {
      response = await fetchCrm(link.tokenUrl(settings), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      })
    } catch (error) {
      throw refusal(`The CRM sign-in did not answer: ${String(error?.message ?? error).slice(0, SAID_MAX)}`)
    }
    const body = await response.json().catch(() => ({}))
    return { response, body }
  }
  const checkedIdToken = (token) => {
    const claims = link.jwtClaims(token)
    const problem = link.idTokenProblem(claims, settings)
    if (problem !== undefined) throw refusal(`The CRM sign-in sent back an unexpected token (${problem}).`)
    return claims
  }

  function ownToken(staffId, { fresh = false } = {}) {
    const held = idTokens.get(staffId)
    if (held?.promise !== undefined) return held.promise
    if (!fresh && held !== undefined && held.until - ID_TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(held.token)
    const promise = (async () => {
      const gap = settings.domain && settings.clientId ? undefined : linkGap()
      if (gap !== undefined) throw refusal(gap)
      const saved = links.read(staffId)
      if (typeof saved?.refreshToken !== 'string') {
        throw refusal(links.has(staffId)
          ? 'Your linked CRM account cannot be opened on this server any more (its key changed). Link it again in Settings → Connectors → CRM.'
          : 'You have not linked your own CRM account. Link it in Settings → Connectors → CRM.')
      }
      const { response, body } = await tokenRequest({ grant_type: 'refresh_token', client_id: settings.clientId, refresh_token: saved.refreshToken })
      if (!response.ok) {
        if (body?.error === 'invalid_grant') {
          await links.remove(staffId).catch(() => {})
          ownCache.delete(staffId)
          throw refusal('Your CRM sign-in expired or was revoked, so your CRM account was unlinked. Link it again in Settings → Connectors → CRM.')
        }
        throw refusal(`The CRM sign-in refused to renew your session (${response.status}${body?.error ? ` ${str(body.error).slice(0, SAID_MAX)}` : ''}).`)
      }
      const claims = checkedIdToken(body?.id_token)
      idTokens.set(staffId, { token: body.id_token, until: claims.exp * 1000 })
      return body.id_token
    })().catch((error) => {
      idTokens.delete(staffId)
      throw error
    })
    idTokens.set(staffId, { promise })
    return promise
  }

  // ---------------------------------------------------------------------------
  // One CRM REST call with the account's credential. A 401 means the authorizer refused
  // before anything ran, so it is tried once more with a fresh grant or token; nothing
  // else is retried, since a send that timed out may have gone out.

  async function crmFetch(acting, account, { method = 'GET', path, query = {}, json, form, write = false, author = false, idempotencyKey, timeout = CRM_TIMEOUT_MS, reason = '' }) {
    const url = new URL(`${settings.apiUrl}${path}`)
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
    const attempt = async (again) => {
      const token = account.via === 'grant'
        ? (await grantFor(acting, account, write ? 'operate' : 'read', reason)).grant
        : await ownToken(acting.person.id, { fresh: again })
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      if (json !== undefined) headers['Content-Type'] = 'application/json'
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey
      let response
      try {
        response = await fetchCrm(url, {
          method,
          headers,
          ...(json !== undefined ? { body: JSON.stringify(json) } : form !== undefined ? { body: form() } : {}),
          signal: AbortSignal.timeout(timeout),
        })
      } catch (error) {
        throw refusal(`The CRM did not answer${write ? '; the change may or may not have been made, so check before trying again' : ''}: ${String(error?.message ?? error).slice(0, SAID_MAX)}`)
      }
      if (response.status === 401 && !again) {
        if (account.via === 'grant') grants.delete(grantKey(acting, account, write ? 'operate' : 'read'))
        else idTokens.delete(acting.person.id)
        return attempt(true)
      }
      const text = await response.text().catch(() => '')
      let body
      try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
      if (!response.ok) {
        const said = str(body?.error ?? body?.message).slice(0, SAID_MAX)
        throw Object.assign(refusal(crmFailureText({ status: response.status, said }, { via: account.via, write, author })), { status: response.status })
      }
      return { status: response.status, body }
    }
    return attempt(false)
  }

  // ---------------------------------------------------------------------------
  // Audit, the write limit and the confirmation for sends to many leads.

  // Ids and counts only: never a message, a name, a phone number or an e-mail address.
  function audit(acting, account, tool, detail = {}) {
    asPerson(acting, () => rt.sla.audit({
      action: `crm.${tool}`,
      targetType: account === undefined ? 'crm' : 'crm_subaccount',
      targetId: account?.subaccountId ?? '',
      detail: {
        botId: acting.bot.id,
        how: acting.how,
        ...(account === undefined ? {} : { via: account.via, mode: modeOf(acting, account), ...(account.productAccountId ? { productAccountId: account.productAccountId } : {}) }),
        ...detail,
      },
    }))
  }

  /** @type {Map<string, number[]>} */
  const recentWrites = new Map()
  function takeWrites(acting, count) {
    const limit = settings.writesPerMinute
    if (count > limit) throw refusal(`That is ${count} changes in one call; the CRM tools make at most ${limit} changes a minute for one person. Split it into smaller batches.`)
    const now = Date.now()
    const recent = (recentWrites.get(acting.person.id) ?? []).filter(at => now - at < 60_000)
    if (recent.length + count > limit) {
      const wait = Math.max(1, Math.ceil((recent[recent.length + count - limit - 1] + 60_000 - now) / 1000))
      throw refusal(`${acting.person.name} has made ${recent.length} CRM changes in the last minute, and the limit is ${limit} a minute. Nothing was done; try again in ${wait} s.`)
    }
    recentWrites.set(acting.person.id, [...recent, ...Array.from({ length: count }, () => now)])
  }

  async function confirmBulk(exec, acting, { count, account, template }) {
    if (acting.how !== 'asked') throw refusal('Sending to several leads at once needs a person to confirm it, and no person started this turn, so nothing was sent.')
    const approval = ctx.get?.('approval')
    if (approval === undefined || exec.agent?.session === undefined) throw refusal(`Sending to ${count} leads needs ${acting.person.name} to confirm it, and there is no way to ask here, so nothing was sent.`)
    const en = `Send the template "${template}" to ${count} leads in ${account.name}, as ${acting.person.name}? Each of them gets a message now.`
    const zh = `以 ${acting.person.name} 的身份，把模板「${template}」发给 ${account.name} 里的 ${count} 个线索吗？他们每人都会立刻收到一条消息。`
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name ?? 'crm_start_conversation',
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: en,
      displayReason: { en, zh },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome === 'allowed-once') return
    throw refusal(outcome === 'rejected' ? 'The send to several leads was not confirmed, so nothing was sent.'
      : outcome === 'cancelled' ? 'The confirmation was cancelled, so nothing was sent.'
        : 'No one could confirm the send to several leads, so nothing was sent.')
  }

  // A file the Bot may hand to the CRM: in its working folder, at most IMPORT_MAX_BYTES.
  async function workspaceFile(exec, path) {
    const folder = rt.sessionFolder?.(exec.agent?.session ?? exec.agent)
    if (typeof folder !== 'string' || folder === '') throw refusal('This Bot has no working folder to read the file from.')
    const base = await rt.real(folder)
    const full = await rt.real(resolve(base, String(path)))
    if (!within(full, base)) throw refusal(`${path} is outside your working folder (${base}); only files in it can be imported.`)
    const info = await stat(full).catch(() => undefined)
    if (info?.isFile() !== true) throw refusal(`There is no file at ${full}.`)
    if (info.size === 0) throw refusal(`${full} is empty.`)
    if (info.size > IMPORT_MAX_BYTES) throw refusal(`${full} has ${info.size} bytes; a CRM import takes at most ${IMPORT_MAX_BYTES}.`)
    return { path: full, data: await readFile(full) }
  }

  installTools(rt, { settings, actingFor, accountsOf, pickAccount, modeOf, crmFetch, audit, takeWrites, confirmBulk, workspaceFile })

  // ---------------------------------------------------------------------------
  // The CRM card in Settings → Connectors, and linking.

  /** @type {Map<string, {staffId:string, verifier:string, at:number}>} */
  const pending = new Map()
  const prunePending = () => {
    const now = Date.now()
    for (const [nonce, entry] of pending) if (now - entry.at > PENDING_LINK_MS) pending.delete(nonce)
    while (pending.size > PENDING_LINKS_MAX) pending.delete(pending.keys().next().value)
  }

  const viewerActing = () => ({ person: rt.viewer(), slaToken: rt.requestContext()?.slaToken, how: 'viewer', cap: 'operate', bot: { id: '' } })
  const ownedBots = person => Object.values(state.bots).filter(bot => ownerOf(bot.id) === person.id && !rt.isMain(bot.id))
    .map(bot => ({ id: bot.id, name: bot.name, unattended: unattendedOf(bot.id) }))

  async function crmView() {
    const acting = viewerActing()
    const person = acting.person
    const saved = links.has(person.id) ? links.read(person.id) : undefined
    const { accounts, problems } = await accountsOf(acting)
    return {
      link: {
        ready: linkGap() === undefined,
        ...(linkGap() === undefined ? {} : { gap: linkGap() }),
        linked: links.has(person.id),
        ...(links.has(person.id) ? { linkedAt: links.linkedAt(person.id), email: str(saved?.email) } : {}),
      },
      accounts: accounts.map(({ ref, via, name, level, subaccountId }) => ({ ref, via, name, level, subaccountId })),
      problems,
      bots: ownedBots(person),
      writesPerMinute: settings.writesPerMinute,
    }
  }

  async function revoke(refreshToken) {
    if (!settings.domain || !settings.clientId) return
    await fetchCrm(link.revokeUrl(settings), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: settings.clientId }).toString(),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    }).catch(error => rt.warn?.('ds-bot: CRM refresh token not revoked: %s', error?.message ?? error))
  }

  const endpoints = {
    'crm-view': () => crmView(),
    'crm-link-start': () => {
      const gap = linkGap()
      if (gap !== undefined) throw refusal(gap)
      prunePending()
      const { verifier, challenge } = link.pkcePair()
      const nonce = link.newState()
      pending.set(nonce, { staffId: rt.viewer().id, verifier, at: Date.now() })
      return { url: link.authorizeUrl(settings, { state: nonce, challenge }) }
    },
    async 'crm-unlink'() {
      const staffId = rt.viewer().id
      const saved = links.read(staffId)
      await links.remove(staffId)
      idTokens.delete(staffId)
      ownCache.delete(staffId)
      if (typeof saved?.refreshToken === 'string') void revoke(saved.refreshToken)
      return crmView()
    },
    async 'crm-unattended'(body) {
      const bot = rt.botOf(str(body.botId))
      if (bot === undefined) throw Object.assign(new Error('Unknown agent'), { code: 'bot/not-found' })
      if (!UNATTENDED_MODES.includes(body.mode)) throw Object.assign(new Error('Choose off, read or operate'), { code: 'bot/invalid' })
      // The Bot then acts with its owner's accounts, so only that person may allow it.
      if (ownerOf(bot.id) !== rt.viewer().id) throw Object.assign(new Error('Only the person this agent is registered to can let it use the CRM on its own'), { code: 'bot/forbidden' })
      const table = ((state.multiuser ??= {}).crm ??= {}).unattended ??= {}
      if (body.mode === 'off') delete table[bot.id]
      else table[bot.id] = { mode: body.mode, by: rt.viewer().id, at: Date.now() }
      await rt.save()
      return crmView()
    },
  }
  rt.crmEndpoint = (endpoint, body = {}) => endpoints[endpoint](body)

  // The CRM's sign-in sends the browser back here through the gateway, which signs the
  // person's identity on it as on every request: the link completes only for the person
  // who started it, once, within ten minutes.
  async function callback(request) {
    const caller = rt.identify(request)
    if (caller.error !== undefined) return callbackPage(401, 'Sign in to Atenea first', 'Open Atenea, then link your CRM account again from Settings → Connectors → CRM.')
    const url = new URL(request.url)
    const nonce = url.searchParams.get('state') ?? ''
    const entry = pending.get(nonce)
    pending.delete(nonce)
    const again = 'Start again from Settings → Connectors → CRM in Atenea.'
    if (entry === undefined || Date.now() - entry.at > PENDING_LINK_MS) return callbackPage(400, 'This link attempt is no longer valid', again)
    if (entry.staffId !== caller.identity.id) return callbackPage(403, 'This link attempt belongs to someone else', again)
    if (url.searchParams.has('error')) return callbackPage(400, 'The CRM sign-in was not completed', `${str(url.searchParams.get('error_description') ?? url.searchParams.get('error')).slice(0, SAID_MAX)} ${again}`)
    const code = url.searchParams.get('code') ?? ''
    if (code === '') return callbackPage(400, 'The CRM sign-in sent no code', again)
    try {
      const { response, body } = await tokenRequest({ grant_type: 'authorization_code', client_id: settings.clientId, code, redirect_uri: settings.redirectUri, code_verifier: entry.verifier })
      if (!response.ok) throw refusal(`The CRM sign-in refused the code (${response.status}${body?.error ? ` ${str(body.error).slice(0, SAID_MAX)}` : ''}).`)
      const claims = checkedIdToken(body?.id_token)
      if (typeof body?.refresh_token !== 'string' || body.refresh_token === '') throw refusal('The CRM sign-in sent no refresh token.')
      await links.write(entry.staffId, { refreshToken: body.refresh_token, sub: claims.sub, email: str(claims.email) })
      idTokens.set(entry.staffId, { token: body.id_token, until: claims.exp * 1000 })
      ownCache.delete(entry.staffId)
      const slaToken = caller.slaToken ?? rt.keptContext(caller.identity.id)?.slaToken
      rt.runAs({ identity: caller.identity, slaToken }, () => rt.sla.audit({ action: 'crm.link', targetType: 'crm_user', targetId: claims.sub, detail: {} }))
    } catch (error) {
      return callbackPage(502, 'Your CRM account was not linked', `${error?.message ?? error} ${again}`)
    }
    return callbackPage(200, 'Your CRM account is linked', 'You can close this window and go back to Atenea.')
  }

  ctx.effect(() => ctx.connection.fetch.register({ path: CRM_CALLBACK_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: callback }), 'ds-bot: crm callback route')
  ctx.effect(() => () => links.settled(), 'ds-bot: crm links')
}
