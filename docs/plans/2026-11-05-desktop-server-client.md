# Desktop app as a client of the Atenea server

- Date: 2026-11-05
- Related: [Desktop app](2026-10-16-desktop-app.md), [Start window](2026-10-26-start-window.md), [Start copy](2026-10-29-start-copy.md)
- Code: `app/src/server.mjs` (the rules), `app/src/main.mjs` (the flow), `app/src/start-window.mjs`, `app/src/start/`, `app/src/preload.cjs`; tests in `app/test/server.test.mjs` and `app/test/main-server.test.mjs`

## Why

Atenea now runs for the whole company as a server: DSH Web with the `ds-bot` plugin behind Caddy at `https://ia.iruzlabs.com`, reachable only over the company WireGuard VPN (the name resolves publicly to a private address). A Cognito sign-in through a gateway will sit in front of it. Each desktop app booting its own DSH Host, data folder and Office runtime splits the team into one copy per laptop. The desktop app should open the shared team instead, keeping what the app adds over a browser tab: its own window, the tray, single instance and updates.

The local engine stays: development, CI and anyone who sets it up on purpose still run the app's own DSH Host exactly as before.

## Decided behavior

### Where the team runs

- The first of these that is set decides:
  1. the environment variable `ATENEA_SERVER_URL`;
  2. `server.json` in the app's own data (`app.getPath('userData')`), `{ "url": "https://…" }`;
  3. the build's default, `atenea.serverUrl` in `app/package.json` (`https://ia.iruzlabs.com`).
- An empty value or `local` (any case) keeps the local engine, also over the build's default. The checks that boot the app (`scripts/check-packed.mjs`, `check-update.mjs`, `check-lifecycle.mjs`, `shot.mjs` unless told otherwise, and the main-process tests) set `ATENEA_SERVER_URL=local`, so they keep exercising the local engine.
- A server address is `https:` only, without user name or password and with nothing after the host (no path, query or hash).
- A setting that is present but unusable (an `http:` address, a path, a `server.json` that does not parse or has no `url`) **stops the start** with the failure page and its reason ("the server address is not valid"); it does not fall through to the next source nor to the local engine. Falling back would run a local team with a local data folder (and the first-run import of `~/.dsh`) on a machine whose owner chose a server, so company work would quietly land in an unmanaged copy, and an `http:` address would send the session over plain text. A visible stop is fixable; a silent fallback is not noticed. 〔Retry〕 on that page reads the setting again; a setting that now asks for the local engine relaunches the app.
- The log says once at start which mode runs and where the setting came from (never a token).

### Server mode

- No local DSH Host, data folder or location picker, import, Office runtime, `restoreSessions`, Bot browser guests or cookie imports. The DSH packages are not even loaded.
- The start window shows as on a later start (kind `server`, line "Connecting to Atenea…").
- The app asks the server once with `GET <url>/` through Electron's `net.request` (Chromium's own stack: the same DNS, proxy and certificates as the window), 4 s timeout, no cookies, redirects not followed. **Any HTTP answer, 401 and 3xx included, means reachable.** No answer (name not resolved, timeout, refused, no route, TLS failure) means not reachable.
- Not reachable: the **VPN card** ("Connect to the Iruz VPN": Atenea only works inside the Iruz VPN) with 〔Retry〕, and the app asks again by itself 5 s after each failed try; the card stays up between tries. A TLS failure says so instead (the certificate is not valid; connect to the VPN or tell whoever runs Atenea). The log names the reason once per change, not every 5 s.
- Reachable: the hidden team window loads the server's URL; the start window hands over when the team view calls `dsBotApp.ready()`, as in local mode.
- The window's preload gets `--ds-bot-server` and exposes a reduced `dsBotApp`: `ready`, the app's own `updates`, `dataLocation()` resolving `null` (the plugin then hides the data location row), `moveData()` resolving `false`, a no-op `teamWorkspaceChanged`, and no `browser` (the plugin runs as in DSH Web). The engine's IPC handlers are not registered at all. `webviewTag` is off.
- Permissions: only the server's own origin is granted, and only `clipboard-read`, `clipboard-sanitized-write`, `fullscreen`, `media` and `notifications`; everything else and every other origin is refused.

### Navigation

- Pages of the server origin (scheme, host and port) stay in the window.
- Sign-in pages open in the system browser: `accounts.google.com`, `login.microsoftonline.com`, any `*.amazoncognito.com` (Cognito's hosted UI) and the gateway's own `/auth` path on the server origin. The gateway's sign-in has to run in one browser from start to end: its state cookie and its callback must meet. Google refuses embedded browsers anyway.
- Every other web page opens in the system browser through `openOutside`; anything that is not `http(s)` goes nowhere.
- A server-side redirect of the main frame away from the server origin is cancelled and opened outside; a redirect inside a frame of the page is left to the frame.

### Access link

- When the window lands on a 401 from DSH Web (it answers 401 until a `?token=` launch link sets its cookie), or the server redirects it to a sign-in, the start window shows the **access link card**: a field to paste the link `https://<server>/?token=…` and 〔Open〕. After a redirect to a sign-in it also says that the sign-in opened in the browser, with a link-style button to open it again.
- The pasted text is accepted only on the server's exact origin, without credentials, outside `/auth`, with a non-empty `token` parameter, up to 4096 characters. It loads **once** in the hidden team window; it is neither stored nor logged (the log only ever has origin and path). Another site's link is refused on the card without loading anything; a link the server answers with 401 says it was refused (used or expired).
- After the hand-off, a 401 or a sign-in redirect brings the start window back with the card over the hidden team window.

### Unchanged

- Tray, menus, single instance and second launch, the close notice, downloads, and the auto-update feed and prompts work the same in both modes.

## Not doing

- No embedded sign-in: the app never shows Google, Microsoft or Cognito pages in its window.
- No hand-back protocol yet (a custom `atenea://` link or a loopback callback from the gateway): pasting the access link is the stopgap until the gateway defines one.
- No settings screen for the server address; `server.json` and the environment variable are for administrators and developers.
- No offline mode and no mixing: one app runs either the local engine or the server, never both.

## Known limits

- The probe only says that something answers at the address; a server that answers but serves something else shows up as a team view that does not call `ready()` within 20 s (the existing "team view didn't load" card with 〔Reload〕).
- Links the server page opens in a new window still go to the system browser, which does not carry the app's session cookie.
- `npm start` from a checkout also follows the build's default; developers set `ATENEA_SERVER_URL=local` for the local engine.

## Changes
