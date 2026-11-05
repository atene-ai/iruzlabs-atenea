# Atenea 服务器网关

- 日期：2026-11-04
- 相关：PR（feat/atenea-gateway）

## 为什么

Iruz Labs 的员工要通过公司 VPN 共用一台 Atenea 服务器（`dsh web` + `ds-bot`，跑在 Docker 里）。`dsh web` 只有一个所有者：拿到它的 cookie 的人能用终端、改设置和密钥、装插件。直接把这个 cookie 给每个员工，就等于每个人都是服务器的所有者，也没法停用某个人、没法按 Bot 区分权限。

取舍：

- 不改 DSH（硬规则）。DSH 0.2.0-rc.2 的浏览器只能以所有者身份登录，没有给浏览器分配非所有者身份的入口，所以「谁能做什么」放在 DSH 外面的一个网关里判断。
- 网关只按路径过滤。DSH 的单次调用是 `POST /api/<命名空间>/<方法>`，DSH 会拒绝正文里的方法和路径不一致的请求，所以路径可靠；但所有流（会话跟随、任务输出、终端……）都走同一个 WebSocket `/api/remote.mux`，网关不解析它。用流的所有者功能改为在 DSH 里用文档化的 `disabled: true` 行关掉（`docker/server.patch.yml`）。
- 身份由网关签名后交给 `ds-bot`，按 Bot 的权限由 `ds-bot` 自己判断；网关只判断「这个人能不能进 Atenea」。

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

### 服务器模式里关掉的 DSH 功能

`ATENEA_SERVER_MODE=1` 时，入口脚本叠加 `docker/server.patch.yml`，关掉：浏览器终端（`terminal-controller`）、插件管理（`plugin-manager`）、DeepSeek 账号登录（`account-controller`）、工作区文件服务（`workspace-files`，连同读它的文件树、文档预览和改动文件卡片）、在主机上打开应用（`open-in-app`），以及只渲染这些功能的浏览器行。设置页保留，只读；保存被网关拒绝。

## 不做什么

- 不解析 `/api/remote.mux` 里的帧。
- 不在网关里按 Bot 过滤 DSH 的会话、任务、工作区调用。
- 不持久化会话；不做多实例网关。

## 已知限制

- Bot 在容器里有完全权限。被放进来的员工可以让 Bot 读容器环境（模型密钥、`ATENEA_IDENTITY_SECRET`）和 `/data` 里所有 Bot 的聊天与记忆。
- DSH 的会话调用不分 Bot：被放进来的员工都以 DSH 所有者身份使用允许的命名空间，能读、能驱动任何 Bot 的会话。按 Bot 的权限只在 `ds-bot` 校验 `x-atenea-identity` 的地方生效。要在 DSH 自己的远程接口上按 Bot 隔离，需要 DSH 提供非所有者的浏览器身份。
- `/api/bot` 整个放行，其中也有所有者级别的操作（提供商密钥、连接器、密钥卡、更新）；在 `ds-bot` 用 `x-atenea-identity` 授权之前，被放进来的人都能用。
- 路由清单按 DSH 0.2.0-rc.2 写；换 DSH 版本时要重新核对命名空间和 `server.patch.yml` 的行 id。

## 变更
