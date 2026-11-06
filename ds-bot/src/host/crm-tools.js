// The CRM tools a Bot works with (crm.js decides whom each call acts for and with what).
// Every call checks its arguments before anything leaves the host, refuses a change in
// read mode before the CRM sees it, and is written to SLA's audit log with ids and
// counts only.
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OUTPUT_MAX = 20_000
const MESSAGE_MAX = 4096
const MESSAGE_READ_MAX = 2000
const RECEIPTS_MAX = 2000
const IMPORT_TYPES = { '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
const IMPORT_DONE = new Set(['COMPLETED', 'FAILED'])
// The CRM fails an import job, after the upload, when any of these columns is
// missing (lowercased, accents dropped, matched as a substring of a header).
const IMPORT_COLUMNS = ['nombre', 'correo', 'telefono']

export function checkImportHeaders(data) {
  const first = new TextDecoder().decode(data.subarray(0, 8192)).replace(/^﻿/, '').split(/\r?\n/, 1)[0]
  const headers = first.split(',').map(header => header.trim().replace(/^"|"$/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())
  const missing = IMPORT_COLUMNS.filter(column => !headers.some(header => header.includes(column)))
  if (missing.length > 0) throw invalid(`The CRM needs the columns Nombre, Correo and Telefono, even when one of them is empty in every row; this file has no ${missing.map(column => column[0].toUpperCase() + column.slice(1)).join(', ')} column. Nothing was imported.`)
}
const GENDERS = ['MALE', 'FEMALE', 'OTHER']
const STATUSES = ['OPEN', 'CLOSED']

const ACCOUNT = {
  type: 'string',
  required: true,
  description: 'The account to act in: its ref from crm_list_accounts ("sla:…" for a customer account SLA assigns to the person who asked, "own:…" for their own linked CRM user), or its exact name',
}

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refusal = message => Object.assign(new Error(message), { code: 'bot/refused' })
const str = value => (typeof value === 'string' ? value : '')
const listOf = value => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.items) ? value.items : [])
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const clip = text => (text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}… (cut; ${text.length} characters in all)` : text)
const json = value => clip(JSON.stringify(value))

// Argument checks: each gives the clean value back or throws a message for the model.
export function textArg(value, label, { max = 200, required = false } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw invalid(`${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw invalid(`${label} must be text.`)
  const clean = value.trim()
  if (clean.length > max) throw invalid(`${label} has ${clean.length} characters; at most ${max}.`)
  return clean
}

export function idArg(value, label, { required = true } = {}) {
  const clean = textArg(value, label, { max: 64, required })
  if (clean !== undefined && !UUID.test(clean)) throw invalid(`${label} must be a CRM id (a UUID), not "${clean}".`)
  return clean
}

export function wholeArg(value, label, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' ? Number(value) : value
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw invalid(`${label} must be a whole number from ${min} to ${max}.`)
  return parsed
}

export function flagArg(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw invalid(`${label} must be true or false.`)
}

// Lead ids as an array, or as one comma-separated string from models that flatten it.
export function idListArg(value, label, { max }) {
  const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map(item => String(item ?? '').trim()).filter(Boolean)
  if (items.length === 0) throw invalid(`${label} needs at least one lead id.`)
  const unique = [...new Set(items)]
  if (unique.length > max) throw invalid(`${label} has ${unique.length} leads; at most ${max} in one call.`)
  for (const item of unique) if (!UUID.test(item)) throw invalid(`${label} must hold CRM lead ids (UUIDs), not "${item}".`)
  return unique
}

const leadSummary = lead => compact({
  id: lead?.id,
  name: lead?.name,
  surname: lead?.surname,
  email: lead?.email,
  phone: lead?.phone,
  stage: lead?.status?.label ?? lead?.status?.key,
  qualification: lead?.qualification?.label ?? lead?.qualification?.key,
  createdAt: lead?.createdAt,
  updatedAt: lead?.updatedAt,
})

const conversationSummary = entry => compact({
  id: entry?.id,
  status: entry?.status,
  channel: entry?.channelName,
  leadId: entry?.contactId,
  lead: entry?.contactDisplayName ?? entry?.contactName,
  phone: entry?.contactPhone,
  lastMessage: entry?.lastMessagePreview,
  aiReplies: entry?.isAiEnabled,
  archived: entry?.isArchived,
  updatedAt: entry?.updatedAt,
})

const messageSummary = message => compact({
  id: message?.id,
  role: message?.role,
  type: message?.type,
  content: typeof message?.content === 'string' && message.content.length > MESSAGE_READ_MAX ? `${message.content.slice(0, MESSAGE_READ_MAX)}… (cut)` : message?.content,
  sender: message?.senderName,
  status: message?.status,
  createdAt: message?.createdAt,
})

function importText(job, running) {
  const counts = `rows ${job?.processedRows ?? 0}/${job?.totalRows ?? 0}: ${job?.successCount ?? 0} added, ${job?.duplicateCount ?? 0} duplicates, ${job?.errorCount ?? 0} rejected`
  const rejected = typeof job?.errorFileUrl === 'string' ? ` The rejected rows, with the reason for each, are at ${job.errorFileUrl} (the link works for 60 minutes).` : ''
  const later = running ? ' It is still running; call crm_import_leads with this job_id to check again.' : ''
  return `Import job ${job?.id ?? '?'}: ${job?.status ?? 'unknown'}, ${counts}.${rejected}${later}`
}

const sleep = (ms, signal) => new Promise((done, fail) => {
  if (signal?.aborted) return fail(signal.reason ?? new Error('stopped'))
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason ?? new Error('stopped')) }, { once: true })
})

export function install(rt, crm) {
  const pollMs = rt.config?.crm?.importPollMs ?? 3000
  const waitMs = rt.config?.crm?.importWaitMs ?? 60_000
  // Template sends this host made, by idempotency key, so a repeated call answers with
  // the first receipt instead of messaging the lead again.
  const receipts = new Map()

  const readOnlyText = (acting, account) => (acting.cap === 'read'
    ? `${acting.bot.name} may only read in the CRM in turns no person started (its owner allowed reading only), so this change was not made.`
    : `${acting.person.name} can only read in ${account.name} (their SLA level there is viewer), so this change was not made in the CRM.`)
  const staffSendText = 'A staff grant cannot send messages yet: the CRM sends the message first and only then records who sent it, which it cannot do for a staff member, so the lead would get the message while the CRM reports a failure. Nothing was sent. Use your own linked CRM account (an "own:" account) if you have a user in that account.'

  // One CRM tool. `writes(input)` counts the changes a call makes (0: only reads);
  // `sends` marks a call that messages leads; `ids(input)` names what it acts on, for
  // the audit log.
  function tool({ name, description, parameters = {}, account = true, writes = () => 0, sends = false, ids = () => ({}), check = () => ({}), run }) {
    rt.teamTools.push(defineTool({
      name,
      description,
      parameters: account ? { account: ACCOUNT, ...parameters } : parameters,
      output,
      async execute(args, exec) {
        const acting = await crm.actingFor(exec)
        let input
        let target
        try {
          input = check(args ?? {})
          if (account) {
            const { accounts, problems } = await crm.accountsOf(acting)
            target = crm.pickAccount(accounts, args?.account, problems)
            const changes = writes(input)
            if (changes > 0 && crm.modeOf(acting, target) === 'read') throw refusal(readOnlyText(acting, target))
            if (changes > 0 && sends && target.via === 'grant' && !crm.settings.staffAuthors) throw refusal(staffSendText)
          }
          const reason = `Atenea: ${acting.bot.name} for ${acting.person.name}${acting.how === 'asked' ? '' : ', on its own'} (${name})`.slice(0, 500)
          const call = options => crm.crmFetch(acting, target, { reason, ...options })
          const result = await run({ input, acting, account: target, exec, call })
          crm.audit(acting, target, name.replace(/^crm_/, ''), { outcome: 'ok', ...ids(input), ...result.detail })
          return result.text
        } catch (error) {
          crm.audit(acting, target, name.replace(/^crm_/, ''), {
            outcome: error?.status !== undefined ? 'failed' : error?.code === 'bot/invalid' ? 'invalid' : 'refused',
            ...(error?.status === undefined ? {} : { status: error.status }),
            ...(target === undefined && account ? { account: str(args?.account).slice(0, 100) } : {}),
            ...(input === undefined ? {} : ids(input)),
          })
          throw error
        }
      },
    }))
  }

  tool({
    name: 'crm_list_accounts',
    description: 'List the CRM accounts you can work in for the person who asked you in this turn: the customer accounts SLA assigns to them (with their level: read only, or read and change) and the subaccounts of their own linked CRM user. Every other crm_ tool takes one of these accounts.',
    account: false,
    async run({ acting }) {
      const { accounts, problems } = await crm.accountsOf(acting)
      const level = account => (crm.modeOf(acting, account) === 'operate' ? 'read and change' : 'read only')
      const staff = accounts.filter(account => account.via === 'grant')
      const own = accounts.filter(account => account.via === 'own')
      const lines = [acting.how === 'asked'
        ? `Acting for ${acting.person.name}, who asked in this turn.`
        : `No person started this turn, so you act for your owner, ${acting.person.name}, with ${acting.cap === 'read' ? 'reading only' : 'reading and changes'} allowed.`]
      lines.push('', staff.length > 0 ? 'Customer accounts SLA assigns (through a staff grant; the CRM keeps some actions for the account\'s own users):' : 'No customer accounts are assigned in SLA.')
      for (const account of staff) lines.push(`- ${account.name}: account "${account.ref}", ${level(account)}`)
      lines.push('', own.length > 0 ? 'Their own CRM user (the CRM\'s own rights apply, and it records them as the author):' : 'No own CRM user with subaccounts is linked (Settings → Connectors → CRM).')
      for (const account of own) lines.push(`- ${account.name}: account "${account.ref}", ${level(account)}`)
      if (problems.length > 0) lines.push('', 'Could not read:', ...problems.map(problem => `- ${problem}`))
      return { text: lines.join('\n'), detail: { count: accounts.length } }
    },
  })

  tool({
    name: 'crm_search_leads',
    description: 'Search the leads (contacts) of a CRM account, newest first unless the CRM says otherwise. Returns their ids, names, contact data, stage and qualification, and the total that match.',
    parameters: {
      search: { type: 'string', description: 'Text to look for in names, phones and e-mail addresses' },
      stage_id: { type: 'string', description: 'Only leads in this pipeline stage (its id)' },
      campaign_id: { type: 'string', description: 'Only leads of this campaign (its id)' },
      has_advisor: { type: 'boolean', description: 'true: only leads with an advisor; false: only leads without one' },
      limit: { type: 'integer', description: 'How many leads, 1 to 50 (default 20)' },
      offset: { type: 'integer', description: 'How many to skip, for the next page' },
    },
    check: args => ({
      search: textArg(args.search, 'search'),
      stageId: idArg(args.stage_id, 'stage_id', { required: false }),
      campaignId: idArg(args.campaign_id, 'campaign_id', { required: false }),
      hasAdvisor: flagArg(args.has_advisor, 'has_advisor'),
      limit: wholeArg(args.limit, 'limit', { min: 1, max: 50, fallback: 20 }),
      offset: wholeArg(args.offset, 'offset', { min: 0, max: 100_000, fallback: 0 }),
    }),
    async run({ input, account, call }) {
      const { body } = await call({
        path: '/api/contacts/v1',
        query: { subaccountId: account.subaccountId, search: input.search, stageId: input.stageId, campaignId: input.campaignId, hasAdvisor: input.hasAdvisor, limit: input.limit, offset: input.offset },
      })
      const leads = listOf(body).map(leadSummary)
      return { text: json({ total: body?.total ?? leads.length, offset: input.offset, leads }), detail: { count: leads.length } }
    },
  })

  tool({
    name: 'crm_get_lead',
    description: 'Read one lead of a CRM account in full.',
    parameters: { lead_id: { type: 'string', required: true, description: 'The lead\'s id' } },
    check: args => ({ leadId: idArg(args.lead_id, 'lead_id') }),
    ids: input => ({ leadId: input.leadId }),
    async run({ input, account, call }) {
      const { body } = await call({ path: `/api/contacts/v1/${input.leadId}`, query: { subaccountId: account.subaccountId } })
      return { text: json(body ?? {}), detail: {} }
    },
  })

  tool({
    name: 'crm_create_lead',
    description: 'Create a lead (contact) in a CRM account. It needs a name and an e-mail address or a phone number.',
    parameters: {
      name: { type: 'string', required: true, description: 'First name' },
      surname: { type: 'string', description: 'Last name' },
      email: { type: 'string', description: 'E-mail address' },
      phone: { type: 'string', description: 'Phone number with country code, digits only (for example 525512345678)' },
      country: { type: 'string', description: 'Two-letter country code, for example MX' },
      country_call_code: { type: 'string', description: 'Country calling code without +, for example 52' },
      gender: { type: 'string', enum: GENDERS, description: 'MALE, FEMALE or OTHER' },
    },
    writes: () => 1,
    check: (args) => {
      const email = textArg(args.email, 'email', { max: 320 })
      if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('email is not an e-mail address.')
      const raw = textArg(args.phone, 'phone', { max: 32 })
      const phone = raw === undefined ? undefined : raw.replace(/[\s()+-]/g, '')
      if (phone !== undefined && !/^\d{6,15}$/.test(phone)) throw invalid('phone must be 6 to 15 digits, with the country code.')
      if (email === undefined && phone === undefined) throw invalid('The CRM needs an e-mail address or a phone number for a lead.')
      const country = textArg(args.country, 'country', { max: 2 })?.toUpperCase()
      if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw invalid('country must be a two-letter code such as MX.')
      const callCode = textArg(args.country_call_code, 'country_call_code', { max: 4 })?.replace(/^\+/, '')
      if (callCode !== undefined && !/^\d{1,4}$/.test(callCode)) throw invalid('country_call_code must be 1 to 4 digits.')
      const gender = textArg(args.gender, 'gender', { max: 10 })?.toUpperCase()
      if (gender !== undefined && !GENDERS.includes(gender)) throw invalid('gender must be MALE, FEMALE or OTHER.')
      return { name: textArg(args.name, 'name', { max: 120, required: true }), surname: textArg(args.surname, 'surname', { max: 120 }), email, phone, country, callCode, gender }
    },
    async run({ input, acting, account, call }) {
      crm.takeWrites(acting, 1)
      const { body } = await call({
        method: 'POST',
        path: '/api/contacts/v1',
        json: compact({ name: input.name, surname: input.surname, email: input.email, phone: input.phone, country: input.country, countryCallCode: input.callCode, gender: input.gender, subaccountId: account.subaccountId }),
        write: true,
      })
      return { text: `Created lead ${body?.id ?? '(the CRM sent no id)'} in ${account.name}.`, detail: { leadId: body?.id } }
    },
  })

  tool({
    name: 'crm_import_leads',
    description: 'Import leads into a CRM account from a CSV (or XLSX) file in your working folder, then wait up to a minute for the import to finish. The file must have the columns Nombre, Correo and Telefono, even when one of them is empty in every row; Apellidos and others are optional. Each row needs a name, and an e-mail address or a phone number. With job_id instead of file, it checks an import already started.',
    parameters: {
      file: { type: 'string', description: 'Path of the .csv or .xlsx file; a relative path starts in your working folder' },
      job_id: { type: 'string', description: 'The id of an import already started, to check how it went' },
    },
    writes: input => (input.file === undefined ? 0 : 1),
    check: (args) => {
      const file = textArg(args.file, 'file', { max: 1000 })
      const jobId = idArg(args.job_id, 'job_id', { required: false })
      if ((file === undefined) === (jobId === undefined)) throw invalid('Give either file (to start an import) or job_id (to check one).')
      if (file !== undefined && !Object.hasOwn(IMPORT_TYPES, extname(file).toLowerCase())) throw invalid('The CRM imports .csv or .xlsx files.')
      return { file, jobId }
    },
    ids: input => (input.jobId === undefined ? {} : { jobId: input.jobId }),
    async run({ input, acting, account, exec, call }) {
      if (input.jobId !== undefined) {
        const { body } = await call({ path: `/api/contacts/v1/imports/${input.jobId}`, query: { subaccountId: account.subaccountId } })
        return { text: importText(body, !IMPORT_DONE.has(body?.status)), detail: { status: body?.status } }
      }
      const file = await crm.workspaceFile(exec, input.file)
      if (extname(file.path).toLowerCase() === '.csv') checkImportHeaders(file.data)
      crm.takeWrites(acting, 1)
      const type = IMPORT_TYPES[extname(file.path).toLowerCase()]
      const { body: started } = await call({
        method: 'POST',
        path: '/api/contacts/v1/imports',
        form: () => {
          const form = new FormData()
          form.set('subaccountId', account.subaccountId)
          form.set('file', new Blob([file.data], { type }), basename(file.path))
          return form
        },
        write: true,
        author: true,
        timeout: 60_000,
      })
      let job = started
      const until = Date.now() + waitMs
      while (typeof job?.id === 'string' && UUID.test(job.id) && !IMPORT_DONE.has(job.status) && Date.now() < until) {
        await sleep(pollMs, exec.signal)
        job = (await call({ path: `/api/contacts/v1/imports/${started.id}`, query: { subaccountId: account.subaccountId } })).body ?? job
      }
      return { text: importText(job, !IMPORT_DONE.has(job?.status)), detail: compact({ jobId: job?.id, status: job?.status, rows: job?.totalRows, added: job?.successCount, rejected: job?.errorCount }) }
    },
  })

  tool({
    name: 'crm_list_conversations',
    description: 'List the conversations (WhatsApp, Telegram and other channels) of a CRM account, or of one lead with lead_id, most recently updated first.',
    parameters: {
      lead_id: { type: 'string', description: 'Only this lead\'s conversations' },
      search: { type: 'string', description: 'Text to look for in the lead\'s name or phone' },
      status: { type: 'string', enum: STATUSES, description: 'OPEN or CLOSED' },
      channel: { type: 'string', description: 'Only one channel, for example whatsapp or telegram' },
      needs_human: { type: 'boolean', description: 'true: only conversations waiting for a person (handoffs)' },
      archived: { type: 'boolean', description: 'true: only archived conversations' },
      limit: { type: 'integer', description: 'How many, 1 to 100 (default 20)' },
      cursor: { type: 'string', description: 'nextCursor of the previous page' },
    },
    check: (args) => {
      const status = textArg(args.status, 'status', { max: 10 })?.toUpperCase()
      if (status !== undefined && !STATUSES.includes(status)) throw invalid('status must be OPEN or CLOSED.')
      const channel = textArg(args.channel, 'channel', { max: 30 })?.toLowerCase()
      if (channel !== undefined && !/^[a-z_]+$/.test(channel)) throw invalid('channel must be a channel name such as whatsapp.')
      return {
        leadId: idArg(args.lead_id, 'lead_id', { required: false }),
        search: textArg(args.search, 'search'),
        status,
        channel,
        needsHuman: flagArg(args.needs_human, 'needs_human'),
        archived: flagArg(args.archived, 'archived'),
        limit: wholeArg(args.limit, 'limit', { min: 1, max: 100, fallback: 20 }),
        cursor: idArg(args.cursor, 'cursor', { required: false }),
      }
    },
    ids: input => (input.leadId === undefined ? {} : { leadId: input.leadId }),
    async run({ input, account, call }) {
      const { body } = input.leadId !== undefined
        ? await call({ path: `/api/contacts/v1/${input.leadId}/conversations`, query: { subaccountId: account.subaccountId, limit: input.limit, cursor: input.cursor } })
        : await call({ path: '/api/conversations/v1', query: { subaccountId: account.subaccountId, search: input.search, status: input.status, channel: input.channel, needsHuman: input.needsHuman, archived: input.archived, limit: input.limit, cursor: input.cursor } })
      const conversations = listOf(body).map(conversationSummary)
      return { text: json(compact({ conversations, nextCursor: body?.nextCursor, hasMore: body?.hasMore })), detail: { count: conversations.length } }
    },
  })

  tool({
    name: 'crm_read_messages',
    description: 'Read the messages of one CRM conversation, newest first. role LEAD is the lead, USER a person from the account, AGENT the account\'s AI, SYSTEM the CRM.',
    parameters: {
      conversation_id: { type: 'string', required: true, description: 'The conversation\'s id' },
      limit: { type: 'integer', description: 'How many, 1 to 50 (default 20)' },
      cursor: { type: 'string', description: 'nextCursor of the previous page, for older messages' },
    },
    check: args => ({
      conversationId: idArg(args.conversation_id, 'conversation_id'),
      limit: wholeArg(args.limit, 'limit', { min: 1, max: 50, fallback: 20 }),
      cursor: idArg(args.cursor, 'cursor', { required: false }),
    }),
    ids: input => ({ conversationId: input.conversationId }),
    async run({ input, account, call }) {
      const { body } = await call({ path: `/api/conversations/v1/${input.conversationId}/messages`, query: { subaccountId: account.subaccountId, limit: input.limit, cursor: input.cursor } })
      const messages = listOf(body).map(messageSummary)
      return { text: json(compact({ newestFirst: true, messages, nextCursor: body?.nextCursor, hasMore: body?.hasMore })), detail: { count: messages.length } }
    },
  })

  tool({
    name: 'crm_send_message',
    description: 'Send a text message to the lead of an open CRM conversation, through its channel. Outside the channel\'s reply window (24 hours on WhatsApp) use crm_start_conversation with an approved template instead.',
    parameters: {
      conversation_id: { type: 'string', required: true, description: 'The conversation\'s id' },
      text: { type: 'string', required: true, description: 'The message, as the lead will read it' },
    },
    writes: () => 1,
    sends: true,
    check: args => ({ conversationId: idArg(args.conversation_id, 'conversation_id'), text: textArg(args.text, 'text', { max: MESSAGE_MAX, required: true }) }),
    ids: input => ({ conversationId: input.conversationId, length: input.text.length }),
    async run({ input, acting, call }) {
      crm.takeWrites(acting, 1)
      const { status, body } = await call({ method: 'POST', path: `/api/conversations/v1/${input.conversationId}/messages`, json: { body: input.text }, write: true, author: true })
      if (status === 206) return { text: `The CRM saved the message (${body?.messageId ?? 'no id'}), but the channel did not deliver it (${body?.status ?? 'FAILED'}). Do not send it again without checking why.`, detail: { status: body?.status ?? 'FAILED' } }
      return { text: `Sent (message ${body?.messageId ?? '?'}, ${body?.status ?? 'SENT'}).`, detail: { status: body?.status } }
    },
  })

  tool({
    name: 'crm_start_conversation',
    description: 'Start (or reopen) a conversation with one or more leads by sending an approved message template through one of the account\'s channels. Without channel_id and template_id it lists the account\'s channels and templates instead, and sends nothing. Sending to more than one lead asks the person who asked you to confirm first. With request_id you name the send yourself: repeating it with the same request_id does not message the leads again.',
    parameters: {
      lead_ids: { type: 'array', items: { type: 'string' }, description: 'The ids of the leads to message' },
      channel_id: { type: 'string', description: 'The account channel (phone number or bot) to send from: an id from the channel list' },
      template_id: { type: 'string', description: 'The template to send, for that channel: a template_id from the template list' },
      request_id: { type: 'string', description: 'Your own name for this send, up to 64 characters, so a repeat does not send twice' },
    },
    writes: input => (input.list ? 0 : input.leadIds.length),
    sends: true,
    check: (args) => {
      const channelId = idArg(args.channel_id, 'channel_id', { required: false })
      const templateId = idArg(args.template_id, 'template_id', { required: false })
      if (channelId === undefined && templateId === undefined) return { list: true }
      if (channelId === undefined || templateId === undefined) throw invalid('Give both channel_id and template_id to send, or neither to list them.')
      return {
        channelId,
        templateId,
        leadIds: idListArg(args.lead_ids, 'lead_ids', { max: Math.min(100, crm.settings.writesPerMinute) }),
        requestId: textArg(args.request_id, 'request_id', { max: 64 }),
      }
    },
    ids: input => (input.list ? { list: true } : { leadIds: input.leadIds, count: input.leadIds.length, channelId: input.channelId, templateId: input.templateId }),
    async run({ input, acting, account, exec, call }) {
      const templates = async () => listOf((await call({ path: '/api/templates/v1', query: { subaccountId: account.subaccountId } })).body)
      if (input.list) {
        const { body: subaccount } = await call({ path: `/api/subaccounts/v1/${account.subaccountId}` })
        // Only these fields: a channel's configuration can hold the channel's own credentials.
        const channels = listOf(subaccount?.channels).map(channel => compact({ id: channel?.id, channel: channel?.channel?.name, channelId: channel?.channelId, status: channel?.status, active: channel?.isActive }))
        const list = (await templates()).map(template => compact({
          name: template?.name,
          status: template?.status,
          channels: listOf(template?.channels).map(entry => compact({ template_id: entry?.id, channel: entry?.channel?.name, channelId: entry?.channelId, providerStatus: entry?.providerStatus })),
        }))
        return { text: json({ channels, templates: list }), detail: { channels: channels.length, templates: list.length } }
      }
      const template = (await templates()).find(entry => listOf(entry?.channels).some(channel => channel?.id === input.templateId))
      if (template === undefined) throw refusal(`There is no template_id ${input.templateId} in ${account.name}. Call crm_start_conversation without channel_id and template_id to list them.`)
      const count = input.leadIds.length
      if (count > 1) await crm.confirmBulk(exec, acting, { count, account, template: str(template.name) || input.templateId })
      crm.takeWrites(acting, count)
      const results = []
      let stopped
      for (const leadId of input.leadIds) {
        if (stopped !== undefined) {
          results.push({ leadId, line: `not tried (${stopped})` })
          continue
        }
        const key = createHash('sha256').update([acting.person.id, account.subaccountId, leadId, input.channelId, input.templateId, input.requestId ?? exec.callId ?? randomUUID()].join('\n')).digest('hex').slice(0, 40)
        const earlier = receipts.get(key)
        if (earlier !== undefined) {
          results.push({ leadId, ...earlier, line: `${earlier.line} (sent before; not sent again)` })
          continue
        }
        try {
          const { status, body } = await call({
            method: 'POST',
            path: '/api/conversations/v1/send-template',
            json: { subaccountChannelId: input.channelId, messageTemplateChannelId: input.templateId, contactId: leadId, subaccountId: account.subaccountId },
            idempotencyKey: key,
            write: true,
            author: true,
          })
          const receipt = status === 206
            ? { sent: false, line: `saved but not delivered${body?.error ? `: ${str(body.error).slice(0, 200)}` : ''}` }
            : { sent: true, line: `sent${body?.conversationId ? ` (conversation ${body.conversationId})` : ''}` }
          receipts.set(key, receipt)
          while (receipts.size > RECEIPTS_MAX) receipts.delete(receipts.keys().next().value)
          results.push({ leadId, ...receipt })
        } catch (error) {
          results.push({ leadId, sent: false, line: `failed: ${error?.message ?? error}` })
          // The same refusal would meet every other lead.
          if ([401, 403, 429].includes(error?.status)) stopped = 'the CRM refused the send before'
        }
      }
      const sent = results.filter(result => result.sent).length
      return {
        text: [`Template "${str(template.name) || input.templateId}" in ${account.name}: ${sent} of ${count} sent.`, ...results.map(result => `- ${result.leadId}: ${result.line}`)].join('\n'),
        detail: { sent, failed: count - sent },
      }
    },
  })

  tool({
    name: 'crm_move_stage',
    description: 'Move a lead to another stage of the account\'s sales pipeline. stage is the stage\'s id, key or name.',
    parameters: {
      lead_id: { type: 'string', required: true, description: 'The lead\'s id' },
      stage: { type: 'string', required: true, description: 'The stage to move it to: its id, key (for example PROSPECT) or name' },
    },
    writes: () => 1,
    check: args => ({ leadId: idArg(args.lead_id, 'lead_id'), stage: textArg(args.stage, 'stage', { max: 100, required: true }) }),
    ids: input => ({ leadId: input.leadId }),
    async run({ input, acting, account, call }) {
      const stages = listOf((await call({ path: '/api/pipeline/v1/stages', query: { subaccountId: account.subaccountId } })).body)
      const wanted = input.stage.toLowerCase()
      const stage = stages.find(entry => entry?.id === input.stage) ?? stages.find(entry => str(entry?.key).toLowerCase() === wanted) ?? stages.find(entry => str(entry?.label).toLowerCase() === wanted)
      if (stage === undefined) throw refusal(`No stage "${input.stage}" in ${account.name}. Its stages: ${stages.map(entry => `${entry?.label} (${entry?.key})`).join(', ') || 'none'}.`)
      crm.takeWrites(acting, 1)
      await call({ method: 'PUT', path: `/api/pipeline/v1/leads/${input.leadId}/stage`, json: { subaccountId: account.subaccountId, stageId: stage.id }, write: true })
      return { text: `Moved lead ${input.leadId} to "${stage.label ?? stage.key}" in ${account.name}.`, detail: { stageId: stage.id } }
    },
  })
}
