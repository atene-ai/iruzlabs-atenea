import { createElement as h, useEffect, useRef, useState } from 'react'
import { Segmented } from './motion.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Sharing a Bot on a shared Atenea server: who else may use it, and how. The owner
// (or a superadmin) adds staff members found in the staff directory, which the host
// reads for them, as editors (chat and change it) or readers (only read).

const SEARCH_DELAY_MS = 250
const SEARCH_MIN = 2
const CONFIRM_MS = 4000
const ROLE_LABELS = { owner: 'Owner', editor: 'Editor', reader: 'Reader' }

export const roleLabel = role => t(ROLE_LABELS[role] ?? 'Reader')

// The people a search found who have no share yet.
export const unshared = (found, shares) => {
  const taken = new Set((shares ?? []).map(share => share.id))
  return (found ?? []).filter(person => !taken.has(person.id))
}

function ShareRow({ share, confirming, busy, onRemove }) {
  const removable = share.role === 'editor' || share.role === 'reader'
  return h('div', { className: 'bt-set-row bt-bs-row bt-share-row' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, share.name || share.email),
      share.email && share.name ? h('span', { className: 'bt-set-hint' }, share.email) : null),
    h('span', { className: 'bt-share-role' }, roleLabel(share.role)),
    removable ? h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm bt-share-remove', disabled: busy, 'data-confirm': confirming || undefined,
      'aria-label': confirming ? t('Click again to remove {name}', { name: share.name || share.email }) : t('Remove {name}', { name: share.name || share.email }),
      onClick: onRemove,
    }, confirming ? t('Remove?') : t('Remove')) : null)
}

function FoundRow({ person, role, busy, onRole, onAdd }) {
  return h('div', { className: 'bt-set-row bt-bs-row bt-share-row' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, person.name || person.email),
      person.email && person.name ? h('span', { className: 'bt-set-hint' }, person.email) : null),
    h(Segmented, { label: t('Access for {name}', { name: person.name || person.email }), value: role, className: 'bt-share-seg' },
      ['editor', 'reader'].map(id => h('button', { key: id, type: 'button', 'aria-pressed': role === id, onClick: () => onRole(id) }, roleLabel(id)))),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onAdd }, t('Add')))
}

export function SharingCard({ bot, actions, Card }) {
  const [shares, setShares] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(null)
  const [roles, setRoles] = useState({})
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(false)
  const searchToken = useRef(0)
  const fail = failure => setError(failure?.message ?? String(failure))

  useEffect(() => {
    let current = true
    setShares(null)
    void Promise.resolve(actions.shares(bot.id))
      .then((value) => { if (current) setShares(value?.shares ?? []) })
      .catch((failure) => { if (current) { setShares([]); fail(failure) } })
    return () => { current = false }
  }, [bot.id])

  useEffect(() => {
    const q = query.trim()
    const token = ++searchToken.current
    if (q.length < SEARCH_MIN) { setFound(null); return undefined }
    const timer = setTimeout(() => {
      void Promise.resolve(actions.searchStaff(q))
        .then((value) => { if (searchToken.current === token) setFound(value?.staff ?? []) })
        .catch((failure) => { if (searchToken.current === token) { setFound([]); fail(failure) } })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (confirming === null) return undefined
    const timer = setTimeout(() => setConfirming(null), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  const change = (request) => {
    setBusy(true)
    return Promise.resolve(request)
      .then((value) => { setError(''); if (Array.isArray(value?.shares)) setShares(value.shares) })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const add = person => change(actions.shareAdd(bot.id, person, roles[person.id] ?? 'editor'))
  const remove = (share) => {
    if (confirming !== share.id) { setConfirming(share.id); return }
    setConfirming(null)
    void change(actions.shareRemove(bot.id, share.id))
  }
  const results = unshared(found, shares)
  const searching = query.trim().length >= SEARCH_MIN
  return h(Card, { title: t('Sharing') },
    shares === null
      ? h('div', { className: 'bt-empty' }, t('Loading…'))
      : shares.map(share => h(ShareRow, { key: share.id ?? share.email, share, busy, confirming: confirming === share.id, onRemove: () => remove(share) })),
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('input', {
        className: 'bt-input', type: 'search', value: query, spellCheck: false, autoComplete: 'off',
        placeholder: t('Search staff by name or email'), 'aria-label': t('Search staff'),
        onChange: event => setQuery(event.target.value),
      })),
    searching && found !== null && results.length === 0 ? h('div', { className: 'bt-empty' }, t('No one found')) : null,
    searching ? results.map(person => h(FoundRow, {
      key: person.id, person, busy, role: roles[person.id] ?? 'editor',
      onRole: role => setRoles(previous => ({ ...previous, [person.id]: role })),
      onAdd: () => { void add(person) },
    })) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null)
}

export const SHARING_CSS = `
.bt-share-row .bt-set-copy{min-width:0}
.bt-share-row .bt-bs-label,.bt-share-row .bt-set-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-share-role{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-share-seg{flex:none}
.bt-share-remove[data-confirm]{color:var(--bt-danger)}
`
