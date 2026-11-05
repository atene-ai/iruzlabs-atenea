// Server mode in the main process (docs/plans/2026-11-05-desktop-server-client.md), against
// DSH Web without a gateway: no Host, no data folder; the VPN card while the server does not
// answer, the access link card while DSH Web answers 401, then the server's page in the team
// window. The token of a pasted link never goes into the log. The gateway's sign-in is in
// main-server-gateway.test.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const SERVER = 'https://ia.example.test'
const TOKEN = 'tk-4f1d-9a2c'
const startWindows = () => state.windows.filter(win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start=')))
const startWin = () => startWindows().at(-1)
const startState = () => startWin()?.webContents.messages.get('ds-bot:start-state')
// What the start page sends; the main process takes it only from the page it loaded.
const act = (name, payload) => {
  const win = startWin()
  win.webContents.mainFrame.url = win.url
  return state.ipc.get('ds-bot:start-act')({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, name, payload)
}
const pageEvent = (contents, name, url, details = {}) => {
  const event = { ...details, prevented: false, preventDefault() { this.prevented = true } }
  contents.emit(name, event, url)
  return event
}

before(async () => {
  // The VPN is off: the server's name resolves, but nothing answers.
  state.netAnswer = () => ({ error: 'net::ERR_CONNECTION_TIMED_OUT' })
  // DSH Web answers 401 to the window until it carries a good access link.
  state.pageStatus = (url) => {
    if (!url.startsWith(`${SERVER}/`)) return undefined
    return new URL(url).searchParams.get('token') === TOKEN ? 200 : 401
  }
  await startApp({ packaged: false, server: SERVER })
})

test('server mode starts no Host and shows the VPN card while the server does not answer', async () => {
  await waitFor(() => startState()?.card?.kind === 'vpn', 'show the VPN card')
  assert.equal(startState().start, 'server')
  assert.deepEqual(startState().card, { kind: 'vpn', host: 'ia.example.test', problem: 'away' })
  assert.equal(hostState.starts, 0, 'no Host was started')
  assert.deepEqual(state.netRequests[0], { method: 'GET', url: `${SERVER}/`, redirect: 'manual', cache: 'no-store', useSessionCookies: false })
  assert.equal(state.dialogs.length, 0, 'no data folder or import was asked for')
  // Without the engine there is no Bot browser and no data location to talk to.
  for (const channel of ['ds-bot:browser-acquire', 'ds-bot:data-location', 'ds-bot:move-data', 'ds-bot:browser-import-apply']) assert.equal(state.ipc.has(channel), false, channel)
  for (const channel of ['ds-bot:ready', 'ds-bot:app-update-state']) assert.equal(state.ipc.has(channel), true, channel)
})

test('the app asks the server again every 5 s, and the card stays up meanwhile', async () => {
  const asked = state.netRequests.length
  await waitFor(() => state.netRequests.length > asked, 'ask the server again', 8000)
  assert.equal(startState().view, 'card')
  assert.equal(window().loaded.length, 0, 'the team window loads nothing yet')
})

test('once the server answers, its page loads; a 401 puts the access link card up', async () => {
  state.netAnswer = () => ({ status: 401 })
  assert.equal(act('reconnect'), true)
  const win = window()
  await waitFor(() => win.loaded.includes(`${SERVER}/`), 'load the server')
  await waitFor(() => startState()?.card?.kind === 'link', 'ask for the access link')
  assert.deepEqual(startState().card, { kind: 'link', host: 'ia.example.test' })
  // The window was made for the server: its preload gets the reduced bridge and no webviews.
  const preferences = win.options.webPreferences
  assert.ok(preferences.additionalArguments.includes(`--ds-bot-origin=${SERVER}`))
  assert.ok(preferences.additionalArguments.includes('--ds-bot-server'))
  assert.equal(preferences.webviewTag, false)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
})

test('a pasted link of another site is refused and never loaded', async () => {
  const before = window().loaded.length
  act('link', { value: `https://evil.test/?token=${TOKEN}` })
  await waitFor(() => startState()?.card?.problem === 'wrong', 'say the link is wrong')
  act('link', { value: `${SERVER}/` })
  assert.equal(window().loaded.length, before)
})

test('a good access link loads once and the team view hands over', async () => {
  const win = window()
  act('link', { value: `  ${SERVER}/?token=${TOKEN}  ` })
  await waitFor(() => win.loaded.includes(`${SERVER}/?token=${TOKEN}`), 'load the access link')
  assert.equal(win.loaded.filter(url => url.includes(TOKEN)).length, 1)
  await waitFor(() => startState()?.view === 'boot', 'take the card away')
  win.url = `${SERVER}/`
  win.webContents.mainFrame.url = win.url
  state.ipc.get('ds-bot:ready')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  await waitFor(() => win.visible === true, 'show the team window')
})

test('the server\'s pages stay in the window; other sites, Google and Microsoft open in the system browser', () => {
  const contents = window().webContents
  assert.equal(pageEvent(contents, 'will-navigate', `${SERVER}/bot/1`).prevented, false)
  for (const url of ['https://github.com/atene-ai', 'https://accounts.google.com/o/oauth2/v2/auth', 'https://login.microsoftonline.com/common']) {
    assert.equal(pageEvent(contents, 'will-navigate', url).prevented, true, url)
    assert.ok(state.opened.includes(url), url)
  }
  const opened = state.opened.length
  assert.equal(pageEvent(contents, 'will-navigate', 'file:///etc/passwd').prevented, true)
  assert.equal(state.opened.length, opened, 'a file is not opened anywhere')
  // A frame inside the page that is redirected elsewhere stays the frame's business.
  assert.equal(pageEvent(contents, 'will-redirect', 'https://accounts.google.com/embed', { isMainFrame: false }).prevented, false)
  assert.equal(state.opened.length, opened)
  // The server's permission rules: only its own origin, only what it needs.
  const asked = (permission, requestingUrl) => new Promise((resolve) => { state.permissions.request(contents, permission, resolve, { requestingUrl }) })
  return Promise.all([asked('notifications', `${SERVER}/`), asked('geolocation', `${SERVER}/`), asked('notifications', 'https://evil.test/')]).then((answers) => {
    assert.deepEqual(answers, [true, false, false])
    assert.equal(state.permissions.check(contents, 'media', SERVER), true)
    assert.equal(state.permissions.check(contents, 'media', 'https://evil.test'), false)
  })
})

test('a plain 401 after the hand-off brings the start window back with the link card', async () => {
  const win = window()
  const starts = startWindows().length
  // The page reloads and DSH Web no longer knows the window.
  assert.equal(await win.navigate(`${SERVER}/`), true)
  await waitFor(() => startWindows().length > starts, 'open the start window again')
  await waitFor(() => startState()?.card?.kind === 'link', 'ask for the access link')
  assert.equal(win.visible, false, 'the team window waits behind the start window')
  // A link the server refuses says so on the card.
  act('link', { value: `${SERVER}/?token=spent-token` })
  await waitFor(() => startState()?.card?.problem === 'spent', 'say the link was refused')
  assert.equal(teamWindows().length, 1)
})

test('the app ends without a Host to stop, and the token never went into the log', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
  assert.equal(hostState.stops, 0)
  const dir = join(paths.userData, 'logs')
  const text = readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')
  assert.match(text, /server mode: the team runs on https:\/\/ia\.example\.test/u)
  assert.match(text, /does not answer \(timeout\)/u)
  assert.doesNotMatch(text, new RegExp(TOKEN, 'u'))
  assert.doesNotMatch(text, /spent-token/u)
})
