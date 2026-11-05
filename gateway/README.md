# Atenea gateway

The door between Iruz Labs staff and the Atenea server. `dsh web` has one owner: whoever
holds its cookie controls everything in it. The gateway keeps that cookie to itself, signs
staff in with the staff Cognito pool, asks SLA whether each person may use Atenea, and
forwards only the requests the Atenea UI needs, with the person's identity attached for
ds-bot.

```
browser ──https──▶ Caddy (VPN only) ──▶ gateway 127.0.0.1:13081 ──▶ dsh web (server mode)
                                          │  Cognito Hosted UI (code + PKCE)
                                          │  SLA GET /api/atenea/me (every ≤60 s)
                                          └─ owner cookie from dsh's launch token
```

Node 24, no dependencies, ESM. `node src/server.js` starts it; `npm test` runs the tests.

## What it does

**Sign-in.** `/auth/login` sends the browser to the Cognito Hosted UI with a fresh
`state`, `nonce` and S256 PKCE challenge; the state is also kept in a short-lived
`__Host-atenea_login` cookie, so a callback only completes in the browser that started
it, once, within ten minutes. `/auth/callback` redeems the code, verifies the ID token
(RS256 against the pool's JWKS, fetched again on an unknown `kid`; `iss`, `aud`,
`token_use=id`, `exp`, `email_verified`, `nonce`), then asks SLA. `/auth/logout` ends the
session, revokes the refresh token and leaves through Cognito's `/logout`.

**Sessions.** In memory, behind the signed (HMAC-SHA256), `HttpOnly`, `Secure`,
`SameSite=Lax` cookie `__Host-atenea_session`. The id rotates every 15 minutes (the old id works
for one more minute, for requests already in flight). A session ends after 12 hours
without requests or 7 days after sign-in, whichever comes first. The signing key is made
at start, so a gateway restart signs everyone out; Cognito's own session makes signing in
again quick. The session holds the ID token and the refresh token; the ID token is
refreshed when less than 5 minutes are left.

**Permissions.** At sign-in and at most every 60 seconds per session, the gateway calls
`GET ${SLA_URL}/api/atenea/me` with `Authorization: Bearer <ID token>`. A 401 or 403 ends
the session: the browser gets the page "Tu cuenta no tiene acceso a Atenea" (or a 403 JSON
answer to API calls), and its WebSockets and live feeds are closed. Sessions that only hold
a stream open are checked by a sweep every 30 seconds, so a suspension takes effect within
about a minute. If SLA cannot be reached, the last answer stands for 5 minutes; after that
requests get 503 until SLA answers again.

The SLA answer the gateway reads (staff fields may also sit at the top level, and `agents`
may be a list of `{ botId, role }`; any role other than the three below is dropped):

```json
{
  "staff": { "id": "…", "email": "…", "displayName": "…", "role": "superadmin" },
  "agents": { "<botId>": "owner" }
}
```

SLA must accept ID tokens issued to the gateway's app client (`aud` is its client id).

**Identity for ds-bot.** Every forwarded request carries two headers, after every
`x-atenea-*` header the browser sent has been removed:

- `x-atenea-identity`: a compact JWS, HS256 with `ATENEA_IDENTITY_SECRET`, with claims
  `{ iss: 'atenea-gateway', aud: 'ds-bot', sub: <staff id>, email, name: <display name>,
  role, agents: { <botId>: 'owner' | 'editor' | 'reader' }, iat, exp: iat + 120 }`.
  ds-bot must check the signature, `iss`, `aud` and `exp` before it trusts any claim.
- `x-atenea-sla-token`: the person's current Cognito ID token, so ds-bot can call SLA on
  their behalf (share management).

**Proxy.** HTTP and WebSocket to `DSH_UPSTREAM`. The gateway trades dsh's launch token for
its own owner cookie (see [Launch token](#launch-token)), keeps it in memory, and on a 401
from dsh drops it, trades the current token again and replays the request (bodies up to
1 MiB, and WebSocket upgrades). Towards dsh it removes the browser's `Cookie`,
`Authorization`, `Forwarded`, `X-Forwarded-*`, `Sec-Fetch-*` and hop-by-hop headers,
sets `Host` to the upstream authority and `Origin` (when present) to the upstream origin,
which dsh's trusted-host check accepts, and strips any `token` query parameter. Towards the
browser it removes every `Set-Cookie` dsh sends. It never logs tokens or cookies.

**CSRF and host checks.** Requests must name `PUBLIC_URL`'s host. Every method other than
GET, HEAD and OPTIONS, and every WebSocket upgrade, must carry `Origin: <PUBLIC_URL>`: a
sibling site under the same registrable domain still receives a `Lax` cookie, and the
gateway replaces `Origin` before dsh could check it.

`GET /healthz` needs no session: 200 `{"ok":true,"upstream":true,"dshSession":…}` when dsh
answers, 503 otherwise.

## Path policy

dsh's unary Remote calls are `POST /api/<namespace>/<method>`, and dsh refuses a body whose
`method` differs from the path, so the gateway filters them by path. Remote streams (Session
follow, job output, the terminal…) all share the WebSocket `/api/remote.mux`; the gateway
reads what the browser sends on it ([Session checks](#session-checks)), and the owner-only
features that use it are also switched off inside dsh ([below](#dsh-features-switched-off)).
Lists follow dsh 0.2.0-rc.2 and live in [`src/policy.js`](src/policy.js); an unknown
namespace is refused. The path policy applies to everyone, superadmins too, before the
Session checks.

| Reaches dsh | |
|---|---|
| `GET`/`HEAD` of pages, assets and `/plugins/…` (client bundles, plugin reload events) | |
| `POST /api/bot`, `GET /api/bot/feed` | the ds-bot channel and its live feed |
| WebSocket `GET /api/remote.mux` | Remote streams; each `open` is checked ([Session checks](#session-checks)) |
| `POST /api/<ns>/<method>` for `session`, `workspace`, `job`, `goals`, `subagents`, `userQuestions`, `messageFeedback`, `sessionFeedback`, `commands`, `fileReferences`, `fileUploads`, `skills`, `sessionReferenceResolver`, `permissionPresets`, `agentPresets`, `llm`, `pluginInventory`, `settings`, `credentials` | chat and navigation; `settings` and `credentials` only `describe` |
| `GET /api/file?path=` | only below `GATEWAY_FILE_ROOTS` (default `/workspace`) |
| `GET /api/session.export` | a Session's log as a ZIP (the same data the chat view reads) |

| Refused (403/404/405) | Why |
|---|---|
| `settings/mutate`, `settings/replace`, `settings/update`, `settings/openSettingsDocument`, `credentials/set`, `credentials/unset` | settings and credential writers |
| `agentPresets/select`, `session/openWorkspacePath` | changes the profile's default preset; starts a program on the host |
| `terminal/*`, `pluginManager/*`, `pluginRegistryProbe/*`, `account/*`, `workspaceFiles/*`, `directoryPicker/*`, `dynamicCordisRunner/*`, `productAnalytics/*`, any other namespace | owner-only, or switched off in dsh |
| `/api/file` outside the work folders | it serves any absolute path dsh can read |
| `/connect`, `/oauth/callback`, `/open-in-app/*`, other `/api/…` routes | API cookie exchange, dsh account sign-in, host program launcher |
| WebSocket to any other path; non-GET methods outside `/api` | |

## Session checks

The path policy decides which kinds of call reach dsh; the Session checks decide, per staff
member, which Sessions they reach. dsh admits every browser as its one owner, so without them
anyone signed in could read or drive any Bot's Session through dsh's own API, or write where
they only read. Superadmins are not checked. Everyone else is held to what ds-bot answers:

- **Asking ds-bot.** `POST /api/bot` `{ endpoint: 'session-access', payload: { sessionIds } }`,
  sent through the gateway's own dsh session with the person's `x-atenea-identity`. ds-bot
  maps each Session to its Bot (own chat, group Sessions, earlier parts, subagents through
  their parent) and answers `{ sessions: { <id>: { allowed: 'write' | 'read' | 'none',
  botId?, roomId? } } }` about the caller only; a Session no Bot owns is `none` for everyone
  but superadmins. Answers are kept 30 s per person and Session. A person whose role or
  `agents` change gets a fresh cache; a 401 or 403 from ds-bot or from dsh for one of their
  checked calls empties theirs. When ds-bot cannot answer, a call gets 503 and a stream is
  refused.
- **Unary calls.** For every `POST /api/<ns>/<method>` in an allowed namespace the gateway
  reads the JSON body (up to 16 MiB; more gets 413), checks it is a dsh call for that path
  (`type: 'client-request'`, the same `method`, `payload.args` an object; otherwise 400), and
  applies the method's rule in [`src/session-rules.js`](src/session-rules.js). A refused call
  gets dsh's own answer shape, HTTP 200 with `result: { ok: false, error: { code:
  'atenea/forbidden', message } }` ("Readers can only view this conversation", "Unknown
  conversation", "Only a superadmin can do this", "This action is not available on a shared
  Atenea server"), and never reaches dsh. A method without a rule is refused (fail closed); a
  test compares the rules with every dsh method ([`test/fixtures/dsh-remotes.json`](test/fixtures/dsh-remotes.json),
  made by [`scripts/dsh-remotes.mjs`](scripts/dsh-remotes.mjs) from dsh 0.2.0-rc.2 and
  0.2.1-rc.5) and fails when an allowed namespace has a method without one.
- **Mentions.** dsh turns `dsh-session:<id>` in a person's message into a snapshot of that
  other Session for the model, so every string of a checked body, and of every `/api/bot`
  body, is searched for one: each mentioned Session needs `read`, and a mention that does not
  decode refuses the call.
- **Lists.** `session/list`, `session/search` and `sessionReferenceResolver/candidates` are
  forwarded and their answer is cut down to the Sessions the caller reads.
- **Routes.** `GET /api/session.export?sessionId=` needs `read` and `POST
  /api/session/uploadFileBinary?sessionId=` needs `write`; exactly one `sessionId` (404 for a
  Session the caller does not see, 403 for one they only read).
- **Remote streams.** A stream is opened by the browser's first message on the mux, `{ type:
  'open', streamId, endpoint, payload: { args } }`; no HTTP call the gateway sees precedes it.
  These are JSON text messages in ordinary WebSocket frames, and dsh's mux negotiates no
  compression (the gateway also removes the browser's `Sec-WebSocket-Extensions` offer and
  refuses a handshake answer that carries one), so the gateway reads the browser-to-dsh frames
  ([`src/websocket.js`](src/websocket.js)) and checks every `open` against the same rules. A
  refused stream is sent on as an `open` of the endpoint `atenea/forbidden`, which dsh does not
  know: dsh fails that one stream and the socket stays up. Streams outside the allowed
  namespaces are refused to everyone. A binary or unreadable message, an unmasked frame or a
  frame with a reserved bit closes the socket, as dsh would. dsh's frames to the browser are
  not read.

Per method, for dsh 0.2.0-rc.2 and 0.2.1-rc.5 (*s* marks a stream; `request.x` is the field
`x` of the argument `request`):

| Rule | Methods |
|---|---|
| **write** on the named Session | `session/prompt`, `session/cancel`, `session/rename`, `session/selectModel`, `session/updateQueue`, `job/kill`, `messageFeedback/put`, `messageFeedback/delete`, `sessionFeedback/record`, and `pinSession`, `unpinSession` of the `workspace` namespace (`request.sessionId`); `commands/execute`, `fileUploads/upload`, `goals/create`, `goals/edit`, `goals/pause`, `goals/resume`, `goals/complete`, `goals/clear`, `userQuestions/answer`, `agentPresets/select`¹ (`agentId`); `subagents/prompt` (`request.parentSessionId`, `request.childSessionId`); `subagents/interruptByParent` (`childSessionId`, `parentSessionId`); route `session/uploadFileBinary` (`?sessionId`) |
| **read** on the named Session | `session/projections`, `session/attachment`, `skills/list`, `messageFeedback/list` (`request.sessionId`); `session/page`, *s* `session/follow` (`request.address`: the Session, or a subagent and its parent); `commands/list`, `fileReferences/list`, `goals/get` (`agentId`); *s* `job/list`, *s* `job/follow` (`request.sessionId`); *s* `userQuestions/attachWait` (`agentId`); route `session.export` (`?sessionId`) |
| **read**, answer cut down | `sessionReferenceResolver/candidates` (`agentId`, then the candidates) |
| answer cut down | `session/list`, `session/search` |
| **superadmin** | `session/create`, `session/fork` (a new Session of dsh's own); `create`, `delete`, `rename`, `insertBefore`, `insertSessionBefore`, `archiveSession`, `unarchiveSession` of the `workspace` namespace (ds-bot owns where Bot Sessions live); `llm/discoverModels` (fetches any URL with any key), `session/workspacePathApplications`; and, also refused by the path policy, `settings/mutate`, `settings/replace`, `settings/update`, `settings/openSettingsDocument`, `credentials/set`, `credentials/unset`, `session/openWorkspacePath` |
| open: names no Session | `agentPresets/list`, `agentPresets/read`, `credentials/describe`, `settings/describe`, `llm/listProviders`, `llm/listConfigurableProviders`, `permissionPresets/catalog`, `pluginInventory/list`, `session/modelCatalog`, `session/canOpenWorkspacePath`, `session/initializeDefaultModel`, `initializeDefault` of the `workspace` namespace; *s* `$events`, *s* `session/control`, *s* `follow` of the `workspace` namespace, *s* `remoteAccess/follow` (0.2.1) |
| refused to everyone but superadmins | any other method or stream of an allowed namespace |
| refused to everyone (path policy) | any other namespace, unary or stream; `$events/result` (answers to dsh's approval and question waterfalls) |

¹ Also refused by the path policy.

## dsh features switched off

The image applies [`docker/server.patch.yml`](../docker/server.patch.yml) when
`ATENEA_SERVER_MODE=1`: documented `disabled: true` rows of the dsh-base and dsh-web-app
bundle patches, each host row with the browser row that only renders it.

| Rows | Feature | Why |
|---|---|---|
| `terminal-controller`, `ui-sidebar-terminal` | Browser terminal | A shell in the container, driven through mux streams |
| `plugin-manager`, `ui-plugin-manager` | Plugin manager | Installs npm bundles (code in the server) and switches plugin rows |
| `account-controller`, `ui-settings-account` | DeepSeek account sign-in | Would sign the shared server into one person's account; streams `account/watch` |
| `workspace-files`, `ui-sidebar-files`, `ui-sidebar-documentpreview`, `ui-deliverables` | File tree, document preview, changed-files cards | Its reads have no workspace containment (any file dsh can read) and `workspaceFiles/changes` is a stream |
| `open-in-app`, `ui-open-in-app` | Open in editor / file manager | Starts host programs |

The settings pages stay: they read redacted settings, and their saves are refused by the
gateway. Models and keys for the server are set in `DATA_DIR/cordis.patch.yml` and the
container environment by whoever deploys it. "Remote access" in the dsh sense (method
policies for non-owner Peers) does not exist in dsh 0.2.0-rc.2; its only browser entry, the
`/connect` API cookie exchange, is refused by the gateway.

## What stays possible

Read this before treating the gateway as a per-person boundary.

- **Bots keep full access inside the container.** The image's only permission preset is
  Full access with no approvals, and the container is the boundary. Anyone the gateway lets
  in can ask a Bot to run commands, read any file in the container or print its
  environment. That includes the model key (`FOUNDRY_API_KEY` in the container
  environment), `ATENEA_IDENTITY_SECRET` (ds-bot needs it to check identities; with it, code
  inside the container could sign identities that ds-bot accepts, though browsers cannot
  send them past the gateway), dsh's cookie key in `/data/.credentials.yaml`, and every
  Bot's chats and memory in `/data`. Keep only Atenea's own key in that environment, give it
  a spending limit, and rotate it if a Bot's output ever shows it.
- **Three host-wide streams are not cut down.** dsh sends every browser, as its owner, the
  `$events` stream (host events: `api-session/added`, `status`, `activity` and `error` for
  every Session, with its working folder and parent; the approval and question waterfalls of
  every Session, with the tool call or the questions in them; goal, command and preset
  changes), the `session/control` stream (the projections of every live Session: title,
  todos, goal, open questions, token use, subagent labels) and the Workspace stream (`follow` of the
  `workspace` namespace: every Workspace and its Session order). The UI needs all three, and the gateway does not read
  dsh's frames to the browser, so any admitted person can read that metadata of every Bot's
  Sessions. The full history (`session/page`, `session/follow`, `session.export`), writing,
  and the other Session streams are checked. Answering a waterfall (`$events/result`) is
  refused by the path policy. Closing this needs dsh to admit a browser as a principal other
  than its owner: dsh 0.2.1's `remoteAccess` service already filters `$events` frames,
  `session/control` items and lists for non-owner principals, but dsh admits a browser only
  with its owner cookie, and no documented hook lets a plugin or the gateway admit one per
  person (`connection/request` runs before the body and not for mux frames). That is a dsh
  change, not something to patch.
- **Files by path.** `/api/file?path=` serves anything below `GATEWAY_FILE_ROOTS`, and Bots'
  work folders live there; a path names no Session, so it is not checked per Bot.
- **The check is as fresh as ds-bot's answer.** A share removed in SLA still counts for up to
  30 s of cache (plus the time until the gateway's next SLA check, at most 60 s); a stream
  already open stays open.
- **Rules follow dsh 0.2.0-rc.2 and 0.2.1-rc.5.** A new dsh method in an allowed namespace is
  refused until it has a rule; a changed argument field name makes the method's calls fail
  with 400 until its rule is updated. Regenerate `test/fixtures/dsh-remotes.json` when
  `DSH_VERSION` changes.
- **ds-bot's channel is passed whole.** `/api/bot` carries owner-level ds-bot actions too
  (provider keys, connectors, secrets, plugin and dsh updates, folder listing); with
  `ATENEA_MULTIUSER=1` ds-bot authorizes each of them from `x-atenea-identity`. The gateway
  only searches its bodies for Session mentions.

## Configuration

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | — | Origin staff open, e.g. `https://ia.iruzlabs.com`; https (http only for loopback) |
| `COGNITO_DOMAIN` | — | Hosted UI origin, `https://<prefix>.auth.mx-central-1.amazoncognito.com` |
| `COGNITO_ISSUER` | — | `https://cognito-idp.mx-central-1.amazonaws.com/<user pool id>` |
| `COGNITO_CLIENT_ID` | — | The `atenea-interna` app client |
| `COGNITO_CLIENT_SECRET` | — | Only for a confidential client (sent as HTTP Basic) |
| `SLA_URL` | — | SLA origin; the gateway calls `/api/atenea/me` |
| `ATENEA_IDENTITY_SECRET` | — | HS256 key shared with ds-bot, at least 32 characters |
| `DSH_UPSTREAM` | `http://127.0.0.1:13080` | dsh web origin; a non-loopback host name must be in dsh's `DSH_TRUSTED_HOST` |
| `DSH_LAUNCH_URL` | — | dsh's launch URL (or its whole `dsh web:` line) |
| `DSH_LAUNCH_URL_FILE` | — | A file holding it, read again whenever a new cookie is needed |
| `GATEWAY_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` inside its own container) |
| `GATEWAY_PORT` | `13081` | Listen port |
| `GATEWAY_FILE_ROOTS` | `/workspace` | Comma-separated folders `/api/file` may serve from |

One of `DSH_LAUNCH_URL` and `DSH_LAUNCH_URL_FILE` is required.

<a id="launch-token"></a>
### Launch token

dsh mints a launch token per process and prints it in its `dsh web: http://…/?token=…`
line, its documented readiness signal. In server mode the image's entrypoint passes dsh's
stdout through a reader that writes that line to `DSH_LAUNCH_URL_FILE` (default
`/run/atenea/dsh-launch-url`, mode 0600, directory 0700, owned by `PUID`), removes the file
left by the previous start, and logs only `dsh web: ready; launch URL written to …`. The
gateway mounts the same volume read-only and runs as the same user. The owner cookie dsh
returns is bound to the authority the gateway uses (`Host` = `DSH_UPSTREAM`'s host), lasts
30 days and survives dsh restarts (its key is in `/data`); the gateway renews it at 90 % of
its lifetime and whenever dsh answers 401.

## Deployment

[`docker/compose.server.yml`](../docker/compose.server.yml) runs both containers:
dsh in server mode, not published, and the gateway (this directory's `Dockerfile`), read-only,
without capabilities, published on `127.0.0.1:13081`. The reverse proxy targets that port
instead of dsh. [`docker/README.md`](../docker/README.md#server-mode-atenea-gateway) has the
steps, the `docker run` equivalent and the Caddy change.

[`scripts/cognito-app-client.sh`](scripts/cognito-app-client.sh) creates or updates the
`atenea-interna` app client in the staff pool (AWS CLI, profile from `AWS_PROFILE`):
Hosted UI code flow, scopes `openid email profile`, callback `<PUBLIC_URL>/auth/callback`,
sign-out URL `<PUBLIC_URL>/`, public client with PKCE, 60-minute ID tokens and 7-day refresh
tokens. It prints the `COGNITO_*` values.

## Tests

```sh
npm test        # node --test test/*.test.js
```

Fakes for Cognito, SLA and dsh web (with ds-bot's `session-access` answer) run in process or
on loopback; nothing needs keys or a network. The session rules are also checked against the
dsh packages ds-bot's tests install (`../ds-bot/dev/harness`, or `DSH_HARNESS`) when they are
there. The server-mode image test is [`docker/test-server.mjs`](../docker/test-server.mjs).

After a dsh upgrade, list its Remote methods again:

```sh
node scripts/dsh-remotes.mjs <dsh 0.2.0-rc.2>/node_modules/@deepseek-ai ../ds-bot/dev/harness/node_modules/@deepseek-ai > test/fixtures/dsh-remotes.json
```
