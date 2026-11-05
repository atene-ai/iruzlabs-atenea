// Server mode behind the Atenea gateway (docs/plans/2026-11-05-desktop-server-client.md): the
// gateway sends a window without its session to /auth/login, which goes on to Cognito's hosted
// sign-in and comes back through /auth/callback to the team. The sign-in happens in the window,
// so that the gateway's cookie lands there; Google and Microsoft never take part in it.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { t } from '../src/start/text.mjs'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const SERVER = 'https://ia.example.test'
const COGNITO = 'https://iruz-atenea.auth.mx-central-1.amazoncognito.com'
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
const startWindows = () => state.windows.filter(win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start=')))
const cards = []
const opened = () => state.opened ?? []

// The gateway and Cognito, as the window meets them: each address and where it redirects to.
let session = false
function gateway(url) {
  const at = new URL(url)
  if (at.origin === SERVER) {
    if (at.pathname === '/auth/login') return `${COGNITO}/oauth2/authorize?client_id=c&state=s1&code_challenge=x`
    if (at.pathname === '/auth/callback') { session = true; return `${SERVER}/` }
    if (at.pathname === '/auth/logout') { session = false; return `${COGNITO}/logout?client_id=c&logout_uri=${encodeURIComponent(`${SERVER}/`)}` }
    return session ? undefined : `${SERVER}/auth/login?return_to=${encodeURIComponent(at.pathname)}`
  }
  if (at.origin === COGNITO) {
    if (at.pathname === '/oauth2/authorize') return at.searchParams.has('identity_provider') ? GOOGLE : `${COGNITO}/login?client_id=c&state=s1`
    if (at.pathname === '/logout') return `${SERVER}/`
    // The user name and password form, sent.
    if (at.pathname === '/login' && at.searchParams.has('sent')) return `${SERVER}/auth/callback?code=c0de&state=s1`
  }
  return undefined
}

before(async () => {
  // The gateway answers a page without a session with a redirect: the server is there.
  state.netAnswer = () => ({ status: 302 })
  state.redirectOf = gateway
  state.pageStatus = url => (url.startsWith(`${SERVER}/`) || url.startsWith(`${COGNITO}/`) ? 200 : undefined)
  await startApp({ packaged: false, server: SERVER })
  // Every card the start window ever showed.
  const watch = setInterval(() => {
    const card = startWindows().at(-1)?.webContents.messages.get('ds-bot:start-state')?.card
    if (card !== undefined && cards.at(-1) !== card) cards.push(card)
  }, 5)
  watch.unref()
})

test('a window without the gateway\'s session is sent to the sign-in, which shows in the window', async () => {
  await waitFor(() => window()?.visible === true, 'show the sign-in')
  const win = window()
  assert.match(win.url, /^https:\/\/iruz-atenea\.auth\.mx-central-1\.amazoncognito\.com\/login\?/u)
  assert.equal(hostState.starts, 0)
  assert.deepEqual(opened(), [], 'nothing went to the system browser')
  assert.deepEqual(cards, [], 'no VPN card and no access link card')
  // The start window handed over and goes.
  await waitFor(() => startWindows()[0].destroyed, 'take the start window away')
})

test('signing in comes back through /auth/callback to the team view in the same window', async () => {
  const win = window()
  assert.equal(await win.navigate(`${COGNITO}/login?client_id=c&state=s1&sent=1`), true)
  assert.equal(win.url, `${SERVER}/`)
  assert.equal(session, true, 'the session cookie belongs to the window')
  win.webContents.mainFrame.url = win.url
  state.ipc.get('ds-bot:ready')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  assert.equal(win.visible, true)
  assert.equal(startWindows().length, 1, 'the start window does not come back')
  assert.equal(teamWindows().length, 1)
  assert.deepEqual(opened(), [])
  assert.deepEqual(cards, [])
})

test('signing out comes back to the sign-in in the window, not to the access link card', async () => {
  const win = window()
  assert.equal(await win.navigate(`${SERVER}/auth/logout`), true)
  assert.match(win.url, /^https:\/\/iruz-atenea\.auth\.mx-central-1\.amazoncognito\.com\/login\?/u)
  assert.equal(win.visible, true)
  assert.equal(startWindows().length, 1)
  assert.deepEqual(cards, [])
  assert.deepEqual(opened(), [])
})

test('Google during the sign-in is refused with a message, and never opened', async () => {
  const win = window()
  const where = win.url
  // A link on Cognito's page, and Cognito sending the window on by itself.
  assert.equal(await win.navigate(GOOGLE), false)
  assert.equal(await win.navigate(`${COGNITO}/oauth2/authorize?identity_provider=Google`), true)
  const said = state.dialogs.filter(box => box.message === t('en', 'dialog.signIn.federated', { provider: 'Google' }))
  assert.equal(said.length, 2)
  assert.equal(said[0].title, 'Atenea')
  assert.deepEqual(opened(), [])
  assert.equal(win.url.startsWith(`${COGNITO}/`), true, `still on the sign-in, was ${where}`)
})

test('after signing in again, Google and Microsoft links of the team open in the system browser', async () => {
  const win = window()
  await win.navigate(`${COGNITO}/login?client_id=c&state=s1&sent=1`)
  assert.equal(win.url, `${SERVER}/`)
  const boxes = state.dialogs.length
  assert.equal(await win.navigate(GOOGLE), false)
  assert.equal(await win.navigate('https://login.microsoftonline.com/common'), false)
  assert.deepEqual(opened(), [GOOGLE, 'https://login.microsoftonline.com/common'])
  assert.equal(state.dialogs.length, boxes, 'no message outside the sign-in')
})

test('the app ends, and the log tells the sign-in without its codes', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  const dir = join(paths.userData, 'logs')
  const text = readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')
  assert.match(text, /asks to sign in \(https:\/\/ia\.example\.test\/auth\/login\); the sign-in shows in the window/u)
  assert.match(text, /signed in to https:\/\/ia\.example\.test; the team view loads/u)
  assert.match(text, /tried to continue with Google/u)
  assert.doesNotMatch(text, /c0de|state=s1|code_challenge/u)
  assert.doesNotMatch(text, /access link card is up/u)
})
