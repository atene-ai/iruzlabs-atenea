// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_NAME = 'Atenea'
export const APP_ID = 'ai.atene.iruzlabs'
export const LEGACY_PRODUCT_NAME = 'DS Bot'
export const LEGACY_ENGINE = 'deepseek-bot-engine'
// The start of every package's file name (artifactName in electron-builder.yml). macOS and deb
// installs find their update by this name, so the build and the update check must agree.
export const ARTIFACT_PREFIX = 'Atenea'

/** Keep the shell data and Chromium encryption identity of an existing installation. */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = env.DS_BOT_SHELL_DATA
  // An explicitly isolated run must never discover an installed application.
  const legacy = explicit || env.DS_BOT_HOME ? undefined : join(app.getPath('appData'), LEGACY_PRODUCT_NAME)
  const reuse = legacy !== undefined && exists(legacy) && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? legacy : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (reuse && platform !== 'win32') {
    app.setName(LEGACY_PRODUCT_NAME)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: reuse }
}
