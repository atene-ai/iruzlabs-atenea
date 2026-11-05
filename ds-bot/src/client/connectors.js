import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { CrmCard } from './crm-card.js'
import { t } from './i18n.js'

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

export const LinearMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M1.64 8.7a6.36 6.36 0 0 1 6.36-6.36c.64 0 1.25.1 1.83.28L2.4 10.05a6.3 6.3 0 0 1-.76-1.35zm.74 3.03l9.4-9.4a6.34 6.34 0 0 1 1.88 4.31 6.36 6.36 0 0 1-6.36 6.36 6.3 6.3 0 0 1-4.92-2.27zm10.74-5.37c-.03-.22-.08-.43-.14-.64l1.37-1.37a6.4 6.4 0 0 1 .65 3.65c0 .35-.03.7-.09 1.03l-1.79-2.67z' }))

export const GrafanaMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a3.5 3.5 0 1 1 3.5-3.5 3.5 3.5 0 0 1-3.5 3.5zm3.8-6.8a5.5 5.5 0 0 0-7.6-1.5 5.4 5.4 0 0 0-2 7.5 1.5 1.5 0 0 1-2.4 1.8 8.4 8.4 0 0 1 3.1-11.6 8.5 8.5 0 0 1 11.7 2.3 1.5 1.5 0 0 1-2.8 1.5z' }))

export const GoogleWorkspaceMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a3.5 3.5 0 1 1 3.5-3.5 3.5 3.5 0 0 1-3.5 3.5zm7.56-4.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z' }))

const MARKS = {
  github: GitHubMark,
  linear: LinearMark,
  grafana: GrafanaMark,
  'google-workspace': GoogleWorkspaceMark,
}

const ABOUT = {
  github: () => t('Repositories, issues, and pull requests'),
  linear: () => t('Issues, projects, cycles, and teams'),
  grafana: () => t('Dashboards, alerts, Prometheus metrics, and Loki logs'),
  'google-workspace': () => t('Gmail, Calendar, Drive, Docs, Sheets, and Slides'),
}

const DOCS_URLS = {
  github: 'https://github.com/settings/personal-access-tokens/new',
  linear: 'https://linear.app/settings/api',
  grafana: 'https://grafana.com/docs/grafana/latest/administration/service-accounts/',
  'google-workspace': 'https://console.cloud.google.com/apis/credentials',
}

const LINK_LABELS = {
  github: () => t('Create a token on GitHub'),
  linear: () => t('Create an API key in Linear'),
  grafana: () => t('Grafana Service Accounts documentation'),
  'google-workspace': () => t('Google Cloud Console Credentials'),
}

const TOKEN_LABELS = {
  github: () => t('GitHub token'),
  linear: () => t('Linear API key'),
  grafana: () => t('Service account token (glsa_...)'),
  'google-workspace': () => t('Credentials (JSON or path to credentials.json)'),
}

function statusText(connector) {
  if (connector.state === 'connecting') return t('Connecting…')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return ABOUT[connector.id]?.() ?? ''
}

function ConnectorRow({ connector, actions }) {
  const [form, setForm] = useState(false)
  const [token, setToken] = useState('')
  const [url, setUrl] = useState(connector.url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return task.then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const connect = () => {
    if (busy || token.trim() === '') return
    const extra = connector.id === 'grafana' ? { url: url.trim() } : {}
    void run(actions.connectorConnect(connector.id, token, extra), () => { setToken(''); setForm(false) })
  }
  const on = connector.state !== 'off'
  const Mark = MARKS[connector.id]
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}`)
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name),
        h('span', { className: 'bt-connector-status' }, statusText(connector))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, t('Try again')) : null,
        on
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, t('Disconnect'))
          : form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setForm(true) }, t('Connect')))),
    !on && form ? h('div', { className: 'bt-connector-form' },
      connector.id === 'grafana' ? h('label', { className: 'bt-q-field bt-secret-field' },
        h('input', {
          className: 'bt-input',
          type: 'url',
          placeholder: t('Grafana instance URL (e.g. https://myorg.grafana.net)'),
          value: url,
          onChange: e => setUrl(e.target.value),
          spellCheck: false,
          autoFocus: true,
        })) : null,
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, {
        value: token,
        onChange: setToken,
        onEnter: connect,
        label: TOKEN_LABELS[connector.id]?.() ?? t('Token'),
        autoFocus: connector.id !== 'grafana',
      })),
      h('div', { className: 'bt-connector-form-row' },
        h('a', { className: 'bt-connector-link', href: DOCS_URLS[connector.id] ?? DOCS_URLS.github, target: '_blank', rel: 'noopener noreferrer' }, LINK_LABELS[connector.id]?.() ?? t('Documentation')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setForm(false); setToken(''); setError(null) } }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || token.trim() === '' || (connector.id === 'grafana' && url.trim() === ''), onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

// Settings → Connectors: one row per connector. On a shared server every staff member
// has a CRM card of their own; the team's connectors are for superadmins.
export function ConnectorsPage({ roster, actions }) {
  const list = roster?.connectors ?? []
  const shared = roster?.multiuser === true
  const team = h('section', { key: 'team', className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, actions }))))
  if (!shared) return team
  return [h(CrmCard, { key: 'crm', actions }), roster.viewer?.superadmin === true ? team : null]
}
