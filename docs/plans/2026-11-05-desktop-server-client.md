# Desktop app as a client of the Atenea server

- Date: 2026-11-05
- Related: [Desktop app](2026-10-16-desktop-app.md), [Start window](2026-10-26-start-window.md), [Start copy](2026-10-29-start-copy.md)
- Code: `app/src/server.mjs` (the rules), `app/src/main.mjs` (the flow), `app/src/start-window.mjs`, `app/src/start/`, `app/src/preload.cjs`; tests in `app/test/server.test.mjs` and `app/test/main-server.test.mjs`

## Why

Atenea now runs for the whole company as a server: DSH Web with the `ds-bot` plugin behind Caddy at `https://ia.iruzlabs.com`, reachable only over the company WireGuard VPN (the name resolves publicly to a private address). The Atenea gateway (`gateway/`) sits in front of it and signs staff in through the Cognito hosted UI. Each desktop app booting its own DSH Host, data folder and Office runtime splits the team into one copy per laptop. The desktop app should open the shared team instead, keeping what the app adds over a browser tab: its own window, the tray, single instance and updates.

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
- Reachable: the hidden team window loads the server's URL. The start window hands over when the window has a page the user must see: the team view (it calls `dsBotApp.ready()`, as in local mode), a sign-in page, or one of the gateway's own error pages on the server origin (an HTTP error other than 401, such as "Tu cuenta no tiene acceso a Atenea"). The last two never call `ready()`, so they hand over once their load has finished.
- The window's preload gets `--ds-bot-server` and exposes a reduced `dsBotApp`: `ready`, the app's own `updates`, `dataLocation()` resolving `null` (the plugin then hides the data location row), `moveData()` resolving `false`, a no-op `teamWorkspaceChanged`, and no `browser` (the plugin runs as in DSH Web). The engine's IPC handlers are not registered at all. `webviewTag` is off.
- Permissions: only the server's own origin is granted, and only `clipboard-read`, `clipboard-sanitized-write`, `fullscreen`, `media` and `notifications`; everything else and every other origin is refused.

### Sign-in through the gateway

- The gateway answers a page without its session with a 302 to `/auth/login`. That page goes on to the Cognito hosted UI (`<prefix>.auth.<region>.amazoncognito.com`, user name and password), which comes back to `/auth/callback`. The gateway then sets `__Host-atenea_session` and redirects to the page asked for (`/`).
- The whole sign-in runs **in the team window**, in its own (default) session: the gateway's state cookie, set by `/auth/login`, and its callback have to meet in one browser, and the session cookie has to land where the team view will use it. A sign-in in the system browser would leave the window signed out for good.
- When the window lands on a sign-in page, the start window hands over and the team window shows it. When the sign-in comes back to the server origin outside `/auth`, the team view loads in the same window, which is already showing. The app's own stylesheets are not injected into sign-in pages.
- Sign-out (`/auth/logout` → Cognito's `/logout` → `/` → `/auth/login`) ends on the sign-in in the same window, never on the access link card.
- Google (`accounts.google.com`) and Microsoft (`login.microsoftonline.com`) refuse embedded browsers. A sign-in in the window that tries to go on to one of them, by a link or by a redirect, is stopped. A box says, in the user's language, that this sign-in must use the Iruz user name and password (Cognito), and the log says so. The staff app client only offers `COGNITO` (`IDENTITY_PROVIDERS=COGNITO` in `gateway/scripts/cognito-app-client.sh`).

### Navigation

- These stay in the window: pages of the server origin (scheme, host and port), the server's own `/auth` path, and Cognito's hosted pages. Cognito counts only on its own `https` domain (`<prefix>.auth.<region>.amazoncognito.com`, default port, no user name).
- Google and Microsoft open in the system browser when the team view links to them. During a sign-in they are refused, as above.
- Every other web page opens in the system browser through `openOutside`; anything that is not `http(s)` goes nowhere. A new window asked for a sign-in page loads in the team window instead.
- A server-side redirect of the main frame away from those pages is cancelled and handled the same way; a redirect inside a frame of the page is left to the frame.

### Access link (DSH Web without the gateway)

- DSH Web on its own answers 401 until a `?token=` launch link sets its cookie. When the window lands on such a plain 401, the start window shows the **access link card**: a field to paste the link `https://<server>/?token=…` and 〔Open〕. Sign-in pages and redirects never bring this card; behind the gateway a page never gets a 401, only the 302 to the sign-in.
- The pasted text is accepted only on the server's exact origin, without credentials, outside `/auth`, with a non-empty `token` parameter, up to 4096 characters. It loads **once** in the hidden team window; it is neither stored nor logged (the log only ever has origin and path). Another site's link is refused on the card without loading anything; a link the server answers with 401 says it was refused (used or expired).
- After the hand-off, a plain 401 brings the start window back with the card over the hidden team window.

### Unchanged

- Tray, menus, single instance and second launch, the close notice, downloads, and the auto-update feed and prompts work the same in both modes.

## Not doing

- No federated sign-in: Google and Microsoft never run inside the window, and a sign-in finished in the system browser is not handed back to the app (no `atenea://` link or loopback callback).
- No settings screen for the server address; `server.json` and the environment variable are for administrators and developers.
- No offline mode and no mixing: one app runs either the local engine or the server, never both.

## Known limits

- The probe only says that something answers at the address; a server that answers but serves something else shows up as a team view that does not call `ready()` within 20 s (the existing "team view didn't load" card with 〔Reload〕).
- Links the server page opens in a new window still go to the system browser, which does not carry the app's session cookie.
- `npm start` from a checkout also follows the build's default; developers set `ATENEA_SERVER_URL=local` for the local engine.
- Only Cognito's default hosted domains count as its sign-in. A custom domain for the hosted UI would open in the system browser, and the window would never sign in, until it is added to the rules (`app/src/server.mjs`).
- A Cognito redirect to Google or Microsoft before the first sign-in page has shown leaves the window without a page: the start window then gives its "team view didn't load" card after 20 s, after the box has said why.
- On Windows the frameless window gives a sign-in page no title bar to drag, and the caption buttons sit over its top right corner.

## Changes
