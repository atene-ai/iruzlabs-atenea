# Bot 在 CRM 里干活

- 日期：2026-11-05
- 相关：分支 `feat/crm-agent-connector`，叠在 PR #7（`feat/multiuser-agents`）上，要在它之后合并；[多人共用的服务器](2026-11-05-multiuser-agents.md)；CRM 一侧的员工授权（ateneai_services PR #164，可能还没部署）

## 为什么

员工想让 Bot 在公司的 CRM（Sales OS，`https://api.iruzlabs.com` 上的 Go Lambda）里干活：查线索、建线索、导入、读和回对话、用模板开新对话、挪漏斗阶段。员工进 CRM 有两种身份：

- **员工授权**：支持和管理员替客户处理账户。SLA 给每个人分配客户账户和级别（viewer 只看，operator 可操作），按需签发最多 15 分钟的授权（grant），CRM 认这个授权。
- **自己的 CRM 用户**：员工本身也是某个 CRM 账户的用户。用自己的用户操作，CRM 自己的权限规则生效，作者也记成他。

难点是 Bot 替谁干活。多人模式只在 `/api/bot` 的请求里知道是谁，Bot 的回合不在任何请求里跑；一个人的权力不能借给另一个人，Bot 之间的消息和定时任务也不能拿别人的账户随便用。

所有行为都在 `ATENEA_MULTIUSER=1` 之后。不设时 CRM 工具不注册，回调路由不存在，CRM 卡片的端点回 `bot/unavailable`。

## 已定的行为

### 替谁干活

- 每次工具调用都按「当前回合是谁开的」来定代表谁（`crm.js` 的 `actingFor`），从不看工具调用可能继承来的请求上下文：AsyncLocalStorage 顺着 promise 传播，一个长期运行的 agent 循环可能带着别人请求的上下文。
- **Bot 自己的聊天**：看开启当前回合的第一条消息。
  - 输入框发的人的消息（`source.kind === 'user'`）用署名（PR #7 的 `authorOf(rpcId)`）找到作者。窗口的认领可能比 Bot 的第一步晚一点，工具最多等 3 秒。
  - 提问卡、视图卡的回答（`user-question-reply`）没有自己的请求 id：`answer-question` 和 `view-reply` 端点记下回答的人，10 分钟内开启的回合算他的。
  - 有人的消息但没有署名（DSH 原生界面、手机 App 或别的客户端发的）：拒绝，不代表任何人。
- **群聊里成员的回合**：看正在跑的那一轮里人写的行（`seq >= round.startSeq`）。都有 `authorId` 且是同一个人 → 代表他；有两个人写过 → 拒绝（说不清替谁，后写的人不能借前一个人的账户）；有一行没署名 → 拒绝；一行人写的都没有 → 当作没人发起。
- **没人发起的回合**（Bot 之间的消息、定时任务、群 Goal 的推进、重启后恢复的工作、轮结束后的迟到回复）代表 Bot 在 SLA 里登记的所有者（`state.multiuser.registered[botId].by`），而且只能做所有者允许的：
  - 所有者在 CRM 卡片里给自己登记的每个 Bot 选「关闭 / 只读 / 可修改」（`crm-unattended`，存在 `state.multiuser.crm.unattended[botId] = { mode, by, at }`），默认关闭。
  - 只有登记的所有者能设，超级管理员也不能替别人打开：Bot 会用所有者的账户。登记的所有者换了人，旧设置作废。
  - 「只读」时所有写工具在调 CRM 之前就拒绝；群发一律拒绝（要人确认，见下）。
  - 没登记所有者的 Bot（多人模式之前的、Main Bot 建的）在没人发起的回合里不能用 CRM。
- 代表的人此刻还必须能写这个 Bot（群聊里：每个成员），用他最新一次请求里的身份算（`rt.access.writes`），所以 Main Bot 照旧只有超级管理员能用，共享被收回后立刻失效。

### SLA token 的寿命

- 网关在每个请求里都带 `x-atenea-sla-token`（这个人的 Cognito ID token，剩不到 5 分钟时网关刷新）。`identity.js` 把每个人最新一次请求的身份和 token 留在内存里（`keptContext`），在 token 的 `exp` 前 30 秒作废；读不出 `exp` 的留 5 分钟。只在内存，不写盘、不写日志、不给浏览器。
- 窗口开着时，每次轮询都会续上；窗口关了，最多一小时后过期。过期后人发起的回合回「X 的 Atenea 会话已过期，打开 Atenea（任何页面都行）再问一次」；没人发起的回合回「所有者的会话过期了，他打开 Atenea 后才能再自己用 CRM」。
- 每次 CRM 调用都要这个 token，用自己 CRM 用户的也要：授权和审计都以这个人的身份调 SLA。调 SLA 时总是用 `rt.runAs` 显式带上这个人的身份和 token。

### 账户

- `crm_list_accounts` 和 CRM 卡片列出两类账户，各缓存 60 秒：
  - SLA `GET /api/atenea/me` 里 `sourceSystem` 是 CRM 的账户（默认 `sales-os`，即 SLA 记 Sales OS 账户用的来源，`ATENEA_CRM_SOURCE_SYSTEM` 可改），`externalId` 是 CRM 的**账户** id，CRM 的子账户在每个账户的 `workspaces` 里（`workspaceId`、`externalId` 为子账户 id、`name`）。CRM 按子账户授权，所以每个 workspace 在 Atenea 里是一个账户（ref `sla:<productAccountId>:<workspaceId>`），授权请求带 `workspaceId`；SLA 不给 `workspaces` 时不列出这个账户，免得把账户 id 当子账户发出去。`accessLevel` 为 operator 的可修改，viewer 的只读。其他产品的账户不列。
  - 已关联的 CRM 用户能进的子账户（`GET /api/subaccounts/v1`）。
- 工具的 `account` 参数接受列表里的 ref（`sla:<productAccountId>`、`own:<subaccountId>`）、id 或准确的名字；能对上多个时拒绝，要求用 ref。找不到时，回答里附上哪类账户读不到、为什么（比如关联已被撤销）。
- 一次调用的模式：SLA 账户按级别；自己的 CRM 用户交给 CRM 自己判断（这里算可修改）；没人发起的回合再按所有者允许的封顶。写工具在只读模式下调 SLA 和 CRM 之前就拒绝，并说明原因（级别是 viewer，或所有者只允许只读）。

### 员工授权

- `POST ${SLA_URL}/api/atenea/grants` `{ productAccountId, mode, reason }`，`reason` 是「Atenea: <Bot> for <人> (<工具>)」，没人发起的回合加「on its own」。按（人、账户、模式）缓存到到期前 60 秒，最长 15 分钟；同时到来的请求共用一次签发。读工具用 read 授权，写工具用 operate 授权，然后 `Authorization: Bearer <grant>` 调 CRM。
- CRM 回 401（授权过期「La concesión ha caducado」，或授权者拒绝）时丢掉这个授权，重新要一个再试一次。只有 401 会重试：授权者在任何动作之前就拒绝了。超时等别的失败不重试；写操作超时会说「可能已经生效，先检查再试」。
- SLA 的拒绝翻成人话：`account_not_assigned`（不再分配给你）、`insufficient_access_level`（你在这个账户只能看）、`grant_signing_unavailable`（SLA 没有签名密钥）、401（Atenea 会话不被接受）。SLA 回 403 时清掉这个人的账户缓存。
- CRM 对授权的拒绝翻成人话：只读授权、员工不能用的路由（只有账户自己的用户能做，建议用自己的 CRM 用户）、别的子账户的记录、授权过期。
- **会记作者的写**：CRM 把作者存在 uuid 列里，`staff:<sub>` 存不进去，所以用授权做导入、备注、流程、订单会失败（500）。导入失败时明确说是这个原因，建议关联自己的 CRM 用户或请账户的用户来做。其他写操作用授权失败（5xx）时也提醒可能是这个原因。
- **发消息**：`crm_send_message` 和 `crm_start_conversation` 用授权时，在调 CRM 之前就拒绝。CRM 先通过渠道把消息发出去，再存发送人；员工存不进去，结果是线索收到了消息、CRM 却报错，Bot 很可能重发。等 CRM 能记员工作者以后，设 `ATENEA_CRM_STAFF_AUTHORS=1` 放开。

### 自己的 CRM 用户

- **关联**：授权码加 S256 PKCE，走 CRM 用户池的 Hosted UI。`crm-link-start` 生成 state（24 字节随机）和 verifier（32 字节随机），记在内存里（10 分钟，最多 200 个），返回 `/oauth2/authorize` 的地址（scope `openid email profile`），窗口在新标签页打开。
- **回调**是 ds-bot 用 `ctx.connection.fetch.register` 注册的 `GET /api/bot/crm/callback`（和 `/api/bot` 一样的方式）。网关照常给它签身份；state 只能用一次，必须是同一个人在 10 分钟内发起的，否则拒绝。用 code 和 verifier 在 `/oauth2/token` 换 token，检查 ID token（`token_use=id`，`iss` 是 CRM 池，`aud` 是 client id，没过期，有 `sub`），必须有 refresh token。回来的页面只有纯文本：不带脚本，`no-referrer`，不能被嵌入。成功后写审计 `crm.link`，目标是 CRM 用户的 `sub`。
- **存放**：refresh token 和 CRM 用户的邮箱按员工 id 用 AES-256-GCM 封存（96 位随机 IV；附加数据含员工 id，挪到别人名下就打不开），密钥是 `ATENEA_CRM_TOKEN_KEY`（32 字节，base64 或 hex），文件是插件 home 下的 `crm-links.json`，权限 0600，原子写。密钥变了，旧记录打不开，提示重新关联。
- **使用**：用 refresh token 换 ID token（CRM 的授权者认这个池的 ID token），内存里缓存到过期前 60 秒；CRM 回 401 时强制换一个再试一次；Cognito 回 `invalid_grant` → 删除关联，告诉这个人重新关联。CRM 自己的权限规则生效，作者记成他。
- **取消关联**：删除记录，不等结果地向 `/oauth2/revoke` 撤销 refresh token。
- **配置**：用户池 id 和 client id 用 CRM 网页自己的变量名 `PUBLIC_AWS_COGNITO_USER_POOL_ID`、`PUBLIC_AWS_COGNITO_USER_POOL_CLIENT_ID`，值从环境读，不写进代码；区域 `PUBLIC_AWS_REGION`，没设就从池 id 的前缀推出来。Hosted UI 域名 `ATENEA_CRM_COGNITO_DOMAIN`，回调地址 `ATENEA_CRM_REDIRECT_URI`（`<PUBLIC_URL>/api/bot/crm/callback`）。缺哪个，卡片和 `crm-link-start` 就说缺哪个；员工授权不受影响。

### 工具

工具和 ds-bot 的团队工具一样放进 `rt.teamTools`，只注册在 Bot 的 Session 里。每个工具（`crm_list_accounts` 除外）都要 `account` 参数。参数先检查（UUID、长度、范围、枚举、邮箱、电话、文件类型），不对就在任何网络调用之前回 `bot/invalid` 的说明。

| 工具 | 调用 | 修改 |
|---|---|---|
| `crm_list_accounts` | SLA `GET /api/atenea/me`，`GET /api/subaccounts/v1` | |
| `crm_search_leads` | `GET /api/contacts/v1`（`search`、`stageId`、`campaignId`、`hasAdvisor`、`limit` ≤ 50、`offset`） | |
| `crm_get_lead` | `GET /api/contacts/v1/{id}` | |
| `crm_create_lead` | `POST /api/contacts/v1`（名字，加邮箱或电话） | ✓ |
| `crm_import_leads` | 工作文件夹里的 `.csv` 或 `.xlsx`（≤ 10 MB，真实路径必须在 Bot 的工作文件夹里）multipart `POST /api/contacts/v1/imports`，再轮询 `GET …/imports/{id}` 最多一分钟；或只带 `job_id` 查进度 | ✓ |
| `crm_list_conversations` | `GET /api/conversations/v1`，或带 `lead_id` 时 `GET /api/contacts/v1/{id}/conversations` | |
| `crm_read_messages` | `GET /api/conversations/v1/{id}/messages`（≤ 50 条，每条最多 2000 字） | |
| `crm_send_message` | `POST /api/conversations/v1/{id}/messages`；206 说明存了但没送达 | ✓ 发消息 |
| `crm_start_conversation` | 不带渠道和模板：`GET /api/subaccounts/v1/{id}`（只取渠道的 id、名字、状态，配置里可能有渠道凭据）和 `GET /api/templates/v1`；带：先确认模板在这个账户里，每个线索 `POST /api/conversations/v1/send-template` | ✓ 发消息 |
| `crm_move_stage` | `GET /api/pipeline/v1/stages` 按 id、key 或名字找阶段，再 `PUT /api/pipeline/v1/leads/{id}/stage` | ✓ |

查询类调用都带上 `subaccountId`，让 CRM 的「别的子账户」检查有据可查。CRM 返回给 Bot 的内容（名字、电话、消息）会进模型的上下文，这是工具的用途；审计里没有这些。

### 审计、限流、群发确认

- **审计**：每次能定下代表谁的调用（包括参数不对、被拒、失败的）都不等结果地写 SLA `POST /api/atenea/audit`：`action` 是 `crm.<工具>`，`targetType` 是 `crm_subaccount`，`targetId` 是子账户 id，`detail` 只有 Bot id、`how`（asked / unattended）、`via`（grant / own）、模式、结果（ok / invalid / refused / failed）、HTTP 状态、id 和数量（线索 id、对话 id、消息长度、行数）。从不写消息内容、名字、电话或邮箱。以代表的人的身份和 token 写。CRM 卡片的取消关联和「没人发起时」的设置走 `/api/bot` 的审计。
- **限流**：每人每分钟最多 30 次修改（`ATENEA_CRM_WRITES_PER_MINUTE`），群发里每个线索算一次。超了在调 CRM 之前拒绝，并说还要等几秒；一次调用就超过上限的直接拒绝，要求分批。
- **群发确认**：`crm_start_conversation` 发给一个以上线索时，先用 ds-bot 现有的审批（`approval.request`：Bot 自己的聊天里是 DSH 的审批卡，群聊里是 ds-bot 的审批卡）请人确认，写明模板名、数量、账户和代表的人。拒绝、取消或没人能答 → 一条都不发。没人发起的回合里不能群发。
- **不重发**：每个线索的请求带 `Idempotency-Key`（人、子账户、线索、渠道、模板、`request_id` 或调用 id 的哈希）。本机记下发过的（最多 2000 条），同一个 `request_id` 再调一次时回第一次的回执，不再发。遇到 401、403、429 后，剩下的线索不再尝试（会被同样拒绝）。

### 界面

- 设置 → 连接器：多人模式下每个员工都能进这一页，顶上是自己的 CRM 卡片：关联或取消关联自己的 CRM 用户（取消要点两次），自己 CRM 用户的子账户，SLA 分配的客户账户和级别（只读信息），以及读不到的原因。自己登记的 Bot 另有一张「没人发起时的 CRM 权限」卡片（关闭 / 只读 / 可修改）。团队的连接器仍只给超级管理员。
- 关联在新标签页完成；回到 Atenea 窗口时（focus、visibilitychange）卡片重新读取。浏览器只调 ds-bot，从不直接调 SLA 或 CRM，也拿不到授权或 CRM 的 token。

## 不做什么

- 不在 ds-bot 里存 CRM 的账户分配：SLA 是唯一来源。
- 不把员工池的 Cognito token 发给 CRM，也不把授权、CRM token 交给浏览器或模型。
- 不接 CRM 的 WebSocket 和 MCP：CRM 一侧不认授权。
- 不改 DSH，也不在这个分支里改网关（见已知限制）。

## 已知限制

- **网关要放行回调**：网关（`feat/atenea-gateway` 的 `gateway/src/policy.js`）目前只放行 `POST /api/bot` 和 `GET /api/bot/feed`，其他 `/api/…` 一律拒绝。要关联自己的 CRM 用户，网关还得放行 `GET /api/bot/crm/callback`，照常签身份、带 SLA token。网关会去掉浏览器的 `Sec-Fetch-*` 并自己持有 DSH 的 cookie，所以 DSH 对跨站请求的拒绝不会挡住这次跳转。
- **CRM 用户池还没有 Hosted UI**：CRM 网页用 Amplify 的 SRP 登录，仓库里没有 OAuth 配置，也找不到池的域名。要能关联，得在池上加 Cognito 域名，给 app client 打开授权码流程和 PKCE（公共客户端，不带 secret），scope 加上 `openid email profile`，回调地址加上 `<PUBLIC_URL>/api/bot/crm/callback`，再设 `ATENEA_CRM_COGNITO_DOMAIN`。没做之前卡片说缺什么，员工授权照常可用。
- **CRM 的授权要先部署**：PR #164 合并了但可能还没部署，`AteneaGrantPublicKeys` 也要设上。在那之前员工授权会被 CRM 当作无效 token 拒绝（401），工具会说授权可能还没在 CRM 里配置。
- **作者**：用员工授权做会记作者的写会失败；发消息在调用前就被拒绝（`ATENEA_CRM_STAFF_AUTHORS` 之前）。
- **去重只在本机**：CRM 公开的 `send-template` 路由今天不读 `Idempotency-Key`（只有内部路由读），所以不重发只靠本机的记录，重启后忘掉；限流也只在这个进程的内存里。
- **署名靠窗口认领**：DSH 原生界面、手机 App 发的消息没有作者，CRM 工具不替任何人干活。一个回合换到新的对话段后，新段不是从人的消息开始，算没人发起。群聊里轮结束后的迟到回复也算没人发起。
- **没人发起的回合要所有者在线**：所有者的 SLA token 只在内存里，窗口关上后最多一小时就过期，过期后 Bot 不能自己用 CRM。
- **缓存**：SLA 改了分配，账户列表最多 60 秒、已签的授权最多 15 分钟后才跟上（CRM 一侧授权本身也最多 15 分钟）。
- **容器里的权限**：Bot 在容器里有完整权限（见[多人共用的服务器](2026-11-05-multiuser-agents.md#已知限制)）。能让 Bot 执行命令的人，就能读到 `ATENEA_CRM_TOKEN_KEY` 和 `crm-links.json`，从而拿到所有员工 CRM 用户的 refresh token；内存里的 SLA token 和授权同理。封存只防磁盘和备份泄露，不防容器里的代码。
- **审计不等结果**：SLA 不可用时审计行丢失，只写日志；定不下代表谁的调用（没署名、会话过期）写不了审计，因为 SLA 要这个人的 token。

## 变更

- 2026-11-05：初版。
