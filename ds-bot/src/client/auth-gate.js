import { createElement as h, useState } from 'react'
import { ATENEA_AVATAR } from './characters.js'
import { hostText, t } from './i18n.js'

export const GoogleMark = () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a3.5 3.5 0 1 1 3.5-3.5 3.5 3.5 0 0 1-3.5 3.5zm7.56-4.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z' }))

export const MicrosoftMark = () => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M2 2h9v9H2V2zm11 0h9v9h-9V2zM2 13h9v9H2v-9zm11 0h9v9h-9v-9z' }))

const failure = err => hostText(err?.message ?? '') || t('Authentication failed')

// The host checks every sign-in; this gate only collects it.
export function AuthGate({ roster, actions }) {
  const [busyProvider, setBusyProvider] = useState(null)
  const [directEmail, setDirectEmail] = useState('')
  const [directProvider, setDirectProvider] = useState('google')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const auth = roster.auth ?? {}
  const domains = auth.domains ?? []

  const startOAuth = async (provider) => {
    setError('')
    setInfo('')
    setBusyProvider(provider)
    try {
      const res = await actions.authStart(provider)
      if (res?.authUrl) {
        window.open(res.authUrl, '_blank', 'noopener,noreferrer')
        setInfo(t('Waiting for authentication in your browser…'))
      } else {
        setBusyProvider(null)
        setInfo(t('This sign-in is not set up on this computer. Ask your administrator.'))
      }
    } catch (err) {
      setBusyProvider(null)
      setError(failure(err))
    }
  }

  const cancelOAuth = async () => {
    setBusyProvider(null)
    setInfo('')
    try { await actions.authCancel() } catch {}
  }

  const submitDirect = async (e) => {
    e?.preventDefault()
    setError('')
    const email = directEmail.trim()
    if (!email) {
      setError(t('Please enter your corporate email'))
      return
    }
    try {
      await actions.authDevLogin({ email, provider: directProvider })
    } catch (err) {
      setError(failure(err))
    }
  }

  return h('div', { className: 'bt-auth-layer' },
    h('div', { className: 'bt-auth-backdrop' }),
    h('div', { className: 'bt-auth-card', role: 'dialog', 'aria-modal': true, 'aria-label': t('Corporate Access') },
      h('img', { className: 'bt-auth-avatar', src: ATENEA_AVATAR, alt: 'Atenea', draggable: false }),
      h('h1', { className: 'bt-auth-title' }, 'Atenea'),
      h('p', { className: 'bt-auth-sub' }, t('Corporate AI Workspace · Iruz Labs')),
      h('span', { className: 'bt-auth-badge' }, t('Exclusive Internal Access')),
      domains.length > 0 ? h('div', { className: 'bt-auth-domains' },
        h('div', { className: 'bt-auth-domains-label' }, t('Authorized corporate accounts only:')),
        h('div', { className: 'bt-auth-domains-chips' },
          domains.map(d => h('span', { key: d, className: 'bt-auth-chip' }, `@${d}`)))) : null,
      error ? h('div', { className: 'bt-auth-alert bt-auth-alert-error', role: 'alert' }, error) : null,
      info ? h('div', { className: 'bt-auth-alert bt-auth-alert-info', role: 'status' }, info) : null,
      busyProvider ? h('div', { className: 'bt-auth-waiting' },
        h('div', { className: 'bt-auth-spinner', 'aria-hidden': true }),
        h('p', { className: 'bt-auth-sub' }, t('Complete sign-in in your browser, then return here.')),
        h('button', { type: 'button', className: 'bt-auth-btn', onClick: cancelOAuth }, t('Cancel')))
        : h('div', { className: 'bt-auth-actions' },
          h('button', { type: 'button', className: 'bt-auth-btn', onClick: () => startOAuth('google') },
            h(GoogleMark), h('span', null, t('Continue with Google Workspace'))),
          h('button', { type: 'button', className: 'bt-auth-btn', onClick: () => startOAuth('microsoft') },
            h(MicrosoftMark), h('span', null, t('Continue with Microsoft 365')))),
      auth.devLogin ? h(DirectSignIn, { domains, directEmail, setDirectEmail, directProvider, setDirectProvider, submitDirect }) : null))
}

function DirectSignIn({ domains, directEmail, setDirectEmail, directProvider, setDirectProvider, submitDirect }) {
  return [
    h('div', { key: 'divider', className: 'bt-auth-divider' }, h('span', null, t('Direct sign-in (development)'))),
    h('form', { key: 'form', className: 'bt-auth-direct', onSubmit: submitDirect },
      h('input', {
        className: 'bt-auth-input',
        type: 'email',
        value: directEmail,
        placeholder: domains[0] ? `nombre@${domains[0]}` : '',
        onChange: e => setDirectEmail(e.target.value),
        required: true,
        autoComplete: 'email',
        'aria-label': t('Corporate email'),
      }),
      h('select', {
        className: 'bt-auth-select',
        value: directProvider,
        onChange: e => setDirectProvider(e.target.value),
        'aria-label': t('Identity Provider'),
      },
      h('option', { value: 'google' }, 'Google Workspace'),
      h('option', { value: 'microsoft' }, 'Microsoft 365')),
      h('button', { type: 'submit', className: 'bt-auth-submit' }, t('Sign in to Atenea'))),
  ]
}
