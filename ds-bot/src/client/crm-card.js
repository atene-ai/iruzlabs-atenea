import { createElement as h, useEffect, useState } from 'react'
import { hostText, t } from './i18n.js'

// -------------------------------------------------------------------------
// The CRM card on a shared Atenea server, for the person signed in: their own CRM user
// (linked through the CRM's sign-in in another window), the customer accounts SLA
// assigns to them with their level there, and what the Bots they own may do in the CRM
// in turns no person started. The host reads all of it for them; the browser never
// calls SLA or the CRM itself.

const CONFIRM_MS = 4000
const LEVELS = { read: 'Read only', operate: 'Read and change' }
const UNATTENDED = [['off', 'Off'], ['read', 'Read only'], ['operate', 'Read and change']]

export const levelLabel = level => t(LEVELS[level] ?? LEVELS.read)

// The SLA accounts and those of the person's own CRM user, each sorted by name.
export function accountGroups(view) {
  const accounts = Array.isArray(view?.accounts) ? view.accounts : []
  const byName = (a, b) => String(a.name).localeCompare(String(b.name))
  return {
    staff: accounts.filter(account => account.via === 'grant').sort(byName),
    own: accounts.filter(account => account.via === 'own').sort(byName),
  }
}

function AccountRow({ account, hint }) {
  return h('div', { className: 'bt-set-row bt-crm-row' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-crm-name' }, account.name),
      hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    h('span', { className: 'bt-tag' }, levelLabel(account.level)))
}

export function CrmCard({ actions }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fail = failure => setError(failure?.message ?? String(failure))
  const load = () => Promise.resolve(actions.crmView()).then((value) => { setView(value); setError('') }, fail)

  useEffect(() => {
    void load()
    // Linking finishes in another window; coming back to this one shows the link.
    const again = () => { if (document.visibilityState !== 'hidden') void load() }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])

  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  const change = (request) => {
    setBusy(true)
    return Promise.resolve(request)
      .then((value) => { if (value?.link) setView(value); setError('') })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const link = () => {
    // Opened on the click, so the browser lets it open; the address follows.
    const opened = window.open('', '_blank')
    void change(Promise.resolve(actions.crmLinkStart()).then((answer) => {
      if (opened) {
        opened.opener = null
        opened.location.href = answer.url
      } else {
        window.open(answer.url, '_blank', 'noopener')
      }
    }, (failure) => {
      opened?.close()
      throw failure
    }))
  }
  const unlink = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    void change(actions.crmUnlink())
  }

  const linked = view?.link?.linked === true
  const { staff, own } = accountGroups(view)
  const bots = Array.isArray(view?.bots) ? view.bots : []
  return [
    h('section', { key: 'crm', className: 'bt-set-section' },
      h('h3', null, t('CRM')),
      h('div', { className: 'bt-set-card bt-crm-card' },
        view === null && !error ? h('div', { className: 'bt-empty' }, t('Loading…')) : null,
        view === null ? null : h('div', { className: 'bt-set-row' },
          h('span', { className: 'bt-set-copy' },
            h('span', null, t('My CRM account')),
            h('span', { className: 'bt-set-hint' }, linked
              ? (view.link.email ? t('Linked as {email}. Bots you ask act as this CRM user, with its rights.', { email: view.link.email }) : t('Linked. Bots you ask act as this CRM user, with its rights.'))
              : view.link.ready ? t('Link your own CRM user, so Bots you ask can work in its accounts as you.') : hostText(view.link.gap ?? ''))),
          h('span', { className: 'bt-set-control' }, linked
            ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-crm-unlink', disabled: busy, 'data-confirm': confirming || undefined, onClick: unlink }, confirming ? t('Unlink?') : t('Unlink'))
            : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !view.link.ready, onClick: link }, t('Link')))),
        linked ? own.map(account => h(AccountRow, { key: account.ref, account, hint: t('Your CRM user') })) : null,
        view === null ? null : h('div', { className: 'bt-set-row' },
          h('span', { className: 'bt-set-copy' },
            h('span', null, t('Customer accounts')),
            h('span', { className: 'bt-set-hint' }, staff.length > 0 ? t('Assigned to you in SLA. Bots you ask reach them with a short grant at your level.') : t('SLA assigns no CRM accounts to you.')))),
        staff.map(account => h(AccountRow, { key: account.ref, account })),
        ...(view?.problems ?? []).map(problem => h('div', { key: problem, className: 'bt-error', role: 'alert' }, hostText(problem))),
        error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null)),
    bots.length === 0 ? null : h('section', { key: 'crm-bots', className: 'bt-set-section' },
      h('h3', null, t('CRM when no one asks')),
      h('div', { className: 'bt-set-card' },
        h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('What your Bots may do in the CRM in turns no person started, such as messages from other Bots and scheduled tasks. They act as you, with your accounts, while your Atenea session lasts.'))),
        bots.map(bot => h('div', { key: bot.id, className: 'bt-set-row bt-crm-row' },
          h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-crm-name' }, bot.name)),
          h('select', {
            className: 'bt-select', 'aria-label': t('CRM for {name} when no one asks', { name: bot.name }), value: bot.unattended ?? 'off', disabled: busy,
            onChange: event => void change(actions.crmUnattended(bot.id, event.target.value)),
          }, UNATTENDED.map(([id, label]) => h('option', { key: id, value: id }, t(label)))))))),
  ]
}

export const CRM_CSS = `
.bt-crm-row .bt-set-copy{min-width:0}
.bt-crm-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-crm-row .bt-tag{flex:none}
.bt-crm-unlink[data-confirm]{color:var(--bt-danger)}
`
