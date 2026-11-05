# Atenea 服务器网关

- 日期：2026-11-04
- 相关：PR（feat/atenea-gateway）

## 为什么

Iruz Labs 的员工要通过公司 VPN 共用一台 Atenea 服务器（`dsh web` + `ds-bot`，跑在 Docker 里）。`dsh web` 只有一个所有者：拿到它的 cookie 的人能用终端、改设置和密钥、装插件。直接把这个 cookie 给每个员工，就等于每个人都是服务器的所有者，也没法停用某个人、没法按 Bot 区分权限。

取舍：

- 不改 DSH（硬规则）。DSH 0.2.0-rc.2 的浏览器只能以所有者身份登录，没有给浏览器分配非所有者身份的入口，所以「谁能做什么」放在 DSH 外面的一个网关里判断。
- 网关先按路径过滤。DSH 的单次调用是 `POST /api/<命名空间>/<方法>`，DSH 会拒绝正文里的方法和路径不一致的请求，所以路径可靠。所有流（会话跟随、任务输出、终端……）都走同一个 WebSocket `/api/remote.mux`；用流的所有者功能在 DSH 里用文档化的 `disabled: true` 行关掉（`docker/server.patch.yml`）。
- 身份由网关签名后交给 `ds-bot`，`/api/bot` 上按 Bot 的权限由 `ds-bot` 自己判断。DSH 自己的会话接口不认识这些身份，所以网关再按会话检查：问 `ds-bot` 这个人对这个会话能读、能写还是看不到，再决定放不放（见下面「会话检查」）。

## 已定的行为

### 登录和会话

- 登录用员工 Cognito 用户池（`Zuri-Staff-prod`，`mx-central-1`）的 Hosted UI：授权码 + PKCE（S256），带 `state` 和 `nonce`。`state` 同时放在 `__Host-atenea_login` cookie 里，回调只能在发起登录的浏览器里、10 分钟内完成一次。
- ID 令牌必须是用户池的 RS256 签名（未知 `kid` 时重新拉取 JWKS），`iss`、`aud`、`token_use=id`、`exp`、`email_verified`、`nonce` 都要对。
- 会话存在网关内存里，浏览器只拿签名的 `__Host-atenea_session` cookie（HttpOnly、Secure、SameSite=Lax）。会话 id 每 15 分钟轮换，旧 id 再有效 1 分钟；12 小时没有请求或登录 7 天后结束。网关重启后所有人重新登录。
- ID 令牌剩不到 5 分钟时用刷新令牌换新的；Cognito 拒绝刷新令牌就结束会话。退出时撤销刷新令牌并经 Cognito `/logout` 离开。

### 权限

- 登录时、之后每个会话最多每 60 秒，网关用员工的 ID 令牌调用 SLA 的 `GET /api/atenea/me`。401 或 403 结束会话，页面显示「Tu cuenta no tiene acceso a Atenea」，这个会话的 WebSocket 和实时推送立即断开。只开着流、不发请求的会话由每 30 秒一次的巡检检查。
- SLA 连不上时沿用上一次的结果 5 分钟，之后返回 503，直到 SLA 恢复。
- 转发给 DSH 的每个请求都带 `x-atenea-identity`（HS256，`ATENEA_IDENTITY_SECRET`，`iss: atenea-gateway`、`aud: ds-bot`、员工 id、邮箱、名字、角色、`agents` 里每个 Bot 的 `owner`/`editor`/`reader`，有效期 120 秒）和 `x-atenea-sla-token`（员工当前的 ID 令牌）。浏览器发来的 `x-atenea-*` 头一律先删掉。

### 代理

- 网关自己用 DSH 的启动令牌换所有者 cookie，只放在内存里；DSH 回 401 时重新读取令牌、重换 cookie，并重发请求（1 MiB 以内的正文和 WebSocket 握手）。启动令牌由镜像的入口脚本写进只有网关挂载的卷（0600），不进日志。
- 发往 DSH 时删掉浏览器的 Cookie、Authorization、转发头和逐跳头，`Host`、`Origin` 改成 DSH 信任的上游地址，去掉 `token` 查询参数；DSH 的 `Set-Cookie` 不回给浏览器。
- 非 GET/HEAD/OPTIONS 请求和 WebSocket 握手必须带 `Origin: <PUBLIC_URL>`。
- 允许的路由和拒绝的路由见 `gateway/README.md`「Path policy」；未知命名空间一律拒绝。`/api/file` 只能读 `/workspace` 下的文件。

### 会话检查

DSH 只认一个所有者，网关以所有者身份转发，所以不检查的话，登录的员工知道会话 id 就能通过 DSH 自己的接口读写任何 Bot 的会话，reader 也能写。超级管理员不检查；其他人按 `ds-bot` 的回答放行。路径策略先对所有人生效，会话检查在它之后。

- **问 `ds-bot`。** 网关用自己的 DSH 会话、带这个人的 `x-atenea-identity` 调 `POST /api/bot` `{ endpoint: 'session-access', payload: { sessionIds } }`。`ds-bot` 把每个会话对到它的 Bot（自己的聊天、群会话、更早的分段、子 agent 顺着父会话往上找），只回答调用者自己的权限：`{ allowed: 'write' | 'read' | 'none', botId?, roomId? }`；不属于任何 Bot 的会话对非超级管理员是 `none`。回答按「人 + 会话」缓存 30 秒；这个人的角色或 `agents` 变了就换一份缓存；`ds-bot` 或 DSH 对他的受检调用回 401/403 时清空他的缓存。`ds-bot` 答不上来时回 503。
- **单次调用。** 允许的命名空间里的每个 `POST /api/<命名空间>/<方法>`，网关先读 JSON 正文（最多 16 MiB，超过回 413），确认是这个路径的 DSH 调用（`type: 'client-request'`、`method` 一致、`payload.args` 是对象，否则 400），再按 `gateway/src/session-rules.js` 里这个方法的规则检查：会话 id 在哪个参数的哪个字段、要读还是要写、还是只给超级管理员。拒绝时用 DSH 自己的回答格式：HTTP 200，`result: { ok: false, error: { code: 'atenea/forbidden', message } }`，请求不到 DSH。没有规则的方法一律拒绝；测试把规则和 DSH 0.2.0-rc.2、0.2.1-rc.5 的全部方法（`gateway/test/fixtures/dsh-remotes.json`，由 `gateway/scripts/dsh-remotes.mjs` 生成）对照，允许的命名空间多出没有规则的方法时测试失败。每个方法的规则见 `gateway/README.md`「Session checks」的表。
- **提及别的会话。** DSH 会把人的消息里的 `dsh-session:<id>` 换成那个会话的快照交给模型，所以提及就是读取。受检正文和每个 `/api/bot` 正文里的所有字符串都要查：提到的会话要求可读，解不开的提及直接拒绝。
- **列表。** `session/list`、`session/search`、`sessionReferenceResolver/candidates` 照常转发，回答只留下调用者能读的会话。
- **路由。** `GET /api/session.export?sessionId=` 要求可读，`POST /api/session/uploadFileBinary?sessionId=` 要求可写；必须正好一个 `sessionId`。
- **流。** 订阅不是由网关看得到的 HTTP 调用建立的，而是浏览器在 mux 上发的第一条消息 `{ type: 'open', streamId, endpoint, payload: { args } }`。这些是普通 WebSocket 文本帧里的 JSON；DSH 的 mux 不协商压缩，网关也删掉浏览器的 `Sec-WebSocket-Extensions`，握手回答带扩展就拒绝。所以网关读浏览器发往 DSH 的帧（RFC 6455，`gateway/src/websocket.js`），每个 `open` 按同一套规则检查。被拒的流改成打开 DSH 不认识的端点 `atenea/forbidden` 再发过去：DSH 只让这一个流失败，连接不断。允许的命名空间以外的流对所有人拒绝。二进制或读不懂的消息、没有掩码或带保留位的帧直接断开连接，和 DSH 自己的做法一样。DSH 发给浏览器的帧不读。

### 服务器模式里关掉的 DSH 功能

`ATENEA_SERVER_MODE=1` 时，入口脚本叠加 `docker/server.patch.yml`，关掉：浏览器终端（`terminal-controller`）、插件管理（`plugin-manager`）、DeepSeek 账号登录（`account-controller`）、工作区文件服务（`workspace-files`，连同读它的文件树、文档预览和改动文件卡片）、在主机上打开应用（`open-in-app`），以及只渲染这些功能的浏览器行。设置页保留，只读；保存被网关拒绝。

## 不做什么

- 不读 DSH 发给浏览器的帧，不在流里逐条过滤。
- 网关不自己判断会话属于哪个 Bot、谁有什么角色：都问 `ds-bot`。
- 不改 DSH。
- 不持久化会话；不做多实例网关。

## 已知限制

- Bot 在容器里有完全权限。被放进来的员工可以让 Bot 读容器环境（模型密钥、`ATENEA_IDENTITY_SECRET`）和 `/data` 里所有 Bot 的聊天与记忆。
- 三个全局流没有按会话过滤。DSH 把它们发给每个以所有者身份连上的浏览器：`$events`（所有会话的 `api-session/added`、`status`、`activity`、`error`，带工作目录和父会话；所有会话的审批和提问 waterfall，带其中的工具调用和问题内容；Goal、命令、预设的变化），`session/control`（所有在线会话的投影：标题、待办、Goal、未答的提问、用量、子 agent 标签），工作区的 `follow` 流（所有工作区和其中会话的顺序）。界面离不开这三个流，网关又不读 DSH 发给浏览器的帧，所以被放进来的人能读到所有 Bot 会话的这些元数据。完整历史（`session/page`、`session/follow`、`session.export`）、写操作和其他会话流都检查了。回答 waterfall 的 `$events/result` 被路径策略拒绝。要关上这一块，需要 DSH 能把浏览器当作所有者以外的身份接入：DSH 0.2.1 的 `remoteAccess` 已经能对非所有者身份过滤 `$events` 帧、`session/control` 条目和列表，但 DSH 只用所有者 cookie 接入浏览器，没有文档化的钩子让插件或网关按人接入（`connection/request` 在读正文之前运行，也不管 mux 帧）。这需要 DSH 改动，不能打补丁。可记入 [DSH 让步总账](2026-10-13-dsh-concessions.md)。
- `/api/file?path=` 按路径读 `GATEWAY_FILE_ROOTS` 下的文件，Bot 的工作文件夹也在那里；路径不对应会话，不按 Bot 检查。
- 检查只和 `ds-bot` 的回答一样新：SLA 里撤销的共享最多还有 30 秒缓存（加上网关下次问 SLA 前的最多 60 秒）；已经打开的流不会因此关闭。
- 规则按 DSH 0.2.0-rc.2 和 0.2.1-rc.5 写。允许的命名空间里新增的方法在有规则之前一律拒绝；参数字段改名会让这个方法回 400，直到更新规则。换 `DSH_VERSION` 时重新生成 `gateway/test/fixtures/dsh-remotes.json`。
- `/api/bot` 整个放行，其中也有所有者级别的操作（提供商密钥、连接器、密钥卡、更新）；`ATENEA_MULTIUSER=1` 时由 `ds-bot` 按 `x-atenea-identity` 逐个授权。网关只查其中的会话提及。
- 路由清单按 DSH 0.2.0-rc.2 写；换 DSH 版本时要重新核对命名空间和 `server.patch.yml` 的行 id。

## 变更

- 2026-11-05：网关按会话检查 DSH 自己的调用和 mux 上的流打开请求（PR feat/gateway-session-guard）；更新「为什么」「不做什么」「已知限制」。
