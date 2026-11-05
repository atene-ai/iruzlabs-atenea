# 多人共用的 Atenea 服务器

- 日期：2026-11-05
- 相关：分支 `feat/multiuser-agents`；[角色与权限](2026-10-07-roles-and-permissions.md)、[隐私 Bot](2026-10-27-private-bots.md)、[群聊](2026-10-07-group-chat.md)

## 为什么

Atenea 作为公司内部的服务器运行（Docker 里的 DSH Web 加 `ds-bot`），多位员工共用一个 Bot 团队。桌面版只有一个用户：企业登录（`auth.js`）是全局的，「用户」只有一个，所有 Bot 和设置都对他开放。共用时要做到：

- 每个请求知道是谁发的；
- 每个人只看到共享给他的 Bot；
- 按角色限制能做的事，删除和共享只归所有者，团队级的权力只归超级管理员；
- 共享的对话里看得出每句话是谁写的，Bot 也知道在跟谁说话；
- 每次改动都留审计记录。

身份和共享关系由公司已有的系统管：前面的网关用 Cognito 认证每个人，SLA（ERP）记录每个 agent 的所有者和共享。`ds-bot` 不另建用户库，只校验网关签发的身份，并代表这个人调用 SLA。

所有行为都在环境变量 `ATENEA_MULTIUSER=1` 之后（插件配置 `multiuser: true` 也可以）。不设时一切照旧：桌面应用、企业登录和现有测试都不变。

## 已定的行为

### 身份

- 网关转发给 DSH Web 的每个请求都带 `x-atenea-identity`：HS256 的 compact JWS，密钥是 `ATENEA_IDENTITY_SECRET`（至少 32 个字符，短了一律拒绝）。claims：`iss: 'atenea-gateway'`、`aud: 'ds-bot'`、`sub`（员工 id）、`email`、`name`、`role`（`superadmin` | `product_lead` | `support`）、`agents`（`{ [botId]: 'owner' | 'editor' | 'reader' }`）、`iat`、`exp`。
- 校验（`src/host/identity.js`）：三段都必须是 base64url；header 的 `alg` 必须是 `HS256`，`typ` 只能省略或是 `JWT`；先验签再信 claims，签名用定长比较（`timingSafeEqual`）；`iss`、`aud`（字符串，或包含 `ds-bot` 的数组）、`exp`（容差 10 秒）、`iat` 不在未来、`exp - iat` 不超过 120 秒；`sub` 不能为空，`role` 必须在列表里；`agents` 里不认识的角色丢掉。
- `/api/bot` 的每个请求（读也一样）和 `/api/bot/feed` 都要校验。缺少或无效时回 HTTP 401，`bot/auth-required`。拒绝的原因写日志（同一原因每分钟最多一次），从不写令牌。
- 通过校验的请求在 AsyncLocalStorage 里带着 `{ identity, slaToken }` 运行（`rt.runAs`），下游用 `rt.viewer()` 读，不用一层层传参数。
- `x-atenea-sla-token`（这个人的 Cognito ID token）只用来代表他调用 SLA：不写日志、不存盘、不发给浏览器。
- 多人模式下桌面的企业登录关闭：`authLocked()` 恒为假，`whenSignedIn()` 立刻通过，`auth-start` 等登录接口拒绝（「Sign-in is handled by the Atenea server」），`auth-view` 返回当前身份。
- 投递（`delivery.js`）不再等全局登录。请求上下文里没有身份时拒绝开始工作（路由已先校验，这里是兜底）；Bot 之间的消息、重启后恢复的工作和定时任务不在任何请求里，照常运行。

### 谁能看到什么

- 一个人能看到某个 Bot：他的 `agents[botId]` 有值，或者他是 `superadmin`。
- 群聊：每个成员他都看得到，才显示这个群。在群里发消息、停止、设 Goal、审批，要求对每个成员都有写权限；删除群要求是每个成员的所有者。没有成员的群只有超级管理员看得到。这样定是因为群里每个成员的工作和结果都在群里流动，只要有一个成员对他隐藏，看群就会泄露；「每个成员」是最简单也最保守的规则。
- 隐藏的 Bot 和群就像不存在：读接口一律回 `bot/not-found`「Unknown agent」，和真的不存在一样。
- 过滤的地方：
  - `state` 视图：`bots`、`rooms`、`mainBotIds`、`exchangeTurns`、`questions`、`views`、`btwCards`、`sideChats`、`secretRequests` 按可见性过滤；`agents`（DSH Agent）、`secrets`、`privateArchives` 只给超级管理员。
  - live 字段：`activity`、`work`（含审批和等待）、`memoryNews`、`learning` 过滤；`connectors` 只给超级管理员。
  - 每个读接口：`chat`、`earlier`、`thinking`、`run-stats`、`exchange`、`exchange-text`、`file-text`、`room-progress`、`memory-view`、`memory-history`、`schedules`。
  - 搜索面板只搜视图里的 Bot 和群，跟着过滤。live feed 只给他看得到的 Bot 推消息和回复流。
- 每个人拿到的 `revision` 带上身份的指纹，共享变化后，轮询的窗口即使团队没有新修订也会拿到新视图。
- 显示偏好（主题、布局等）和侧栏的置顶、隐藏按人保存（`state.multiuser.prefs`、`state.multiuser.flags`）。新 Bot 的默认模型仍是团队的，只有超级管理员能改。

### 角色

| | reader | editor | owner | superadmin |
|---|---|---|---|---|
| 看到 Bot、它的历史、结果和记忆 | ✓ | ✓ | ✓ | 所有 Bot |
| 聊天：发消息，回答提问卡、视图、审批、密钥卡，停止，侧边对话 | | ✓ | ✓ | ✓ |
| 改 Bot：名字、标签、指令、模型、头像、能力、定时任务、它的记忆 | | ✓ | ✓ | ✓ |
| 设为隐私 Bot | | | ✓ | ✓ |
| 删除 Bot，改共享 | | | ✓ | ✓ |
| 工作文件夹、沙盒权限、浏览器授权 | | | | ✓ |
| 和 Main Bot 聊天或改它 | | | | ✓ |
| 团队设置：模型服务商、连接器、密钥库、能力库、用量、诊断、更新、Main Bot 身份、团队记忆、团队工作区、DSH Agent、隐私 Bot 的保留项 | | | | ✓ |
| 建自己的 Bot | 每位员工 | | | |

- reader 调写接口回 `bot/forbidden`「Readers can only view this agent」（群里是「Readers can only view this group chat」）；不是所有者调管理接口回「Only the owner of this agent can do this」；不是超级管理员调团队接口回「Only a superadmin can do this」；Main Bot 回「Only a superadmin can work with a Main Bot」。
- 和 Main Bot 说话就是在用它管理整个团队的权力（建、改、停任何 Bot），所以即使 SLA 把 Main Bot 共享成 editor，也只有超级管理员能写。
- 工作文件夹和沙盒权限决定 Bot 能碰到服务器上的哪里，所以只给超级管理员；建 Bot 时带文件夹也一样。
- 团队记忆只有超级管理员能改：`memory-forget` 的团队范围走管理员规则，记忆面板的提问和恢复里涉及团队记忆的修改在 `memory.js` 里拒绝。Bot 自己的记忆工具不受影响。
- 规则表是 `src/host/access.js` 的 `ENDPOINT_RULES`，每个端点一条：`any`、`read`、`write`、`manage`、`create`、`admin`、`off`，以及它作用在哪个 Bot、群或会话上。没有规则的端点在多人模式下一律拒绝；单元测试扫描 `channel.js` 的 switch，新端点缺规则测试就失败。

### 给网关的会话权限

- `session-access` 端点（规则 `any`）：`{ sessionIds: [...] }`，一次最多 500 个，只回答调用者自己的权限：`{ sessions: { [id]: { allowed: 'write' | 'read' | 'none', botId?, roomId? } } }`。网关在转发 DSH 自己的会话调用和流之前问它（见 [网关](2026-11-04-atenea-gateway.md)「会话检查」）。只在多人模式下回答，否则 `bot/unavailable`。
- 会话对到 Bot 的方式和 `access.js` 的 `sessionTarget` 一样：Bot 自己的聊天和更早的分段、群自己的会话和分段、成员在群里的隐藏会话（按群的规则）。子 agent 会话顺着父会话往上找到属于 Bot 的那个：在线的看 Agent 的 `header.parentSession`，冷的看 DSH 的会话列表（`sessionController.list`，没找到时最多每 5 秒重新列一次）。
- 权限和 `/api/bot` 一样：看得到就是 `read`，能写（owner、editor；Main Bot 只有超级管理员）就是 `write`。不属于任何 Bot 的会话（DSH 自己的会话、DSH Agent 的会话）对非超级管理员是 `none`。`none` 不带 `botId`，不透露会话属于谁。

### SLA

- 地址是 `SLA_URL`，请求带 `Authorization: Bearer <x-atenea-sla-token>`，10 秒超时（`src/host/sla.js`）。
- 建 Bot（`create-bot`，`duplicate-bot` 也一样）之后调 `PUT /api/atenea/agents/{botId}` `{ name }`，让建的人成为所有者。SLA 失败就删掉刚建的 Bot，并报「Could not register the agent in SLA, so it was not created: …」。
- 删除 Bot 之后调 `DELETE /api/atenea/agents/{botId}`；失败只写日志，删除照样成立。
- 共享：所有者在 Bot 设置的「Sharing」卡片里看当前共享（`shares` → `GET …/shares`），搜索员工（`staff-search` → `GET /api/atenea/staff?q=`，至少 2 个字符），加为 Editor 或 Reader（`share-add` → `PUT …/shares`），移除（`share-remove` → `DELETE …/shares/{staffUserId}`）。浏览器只调 `ds-bot`，从不直接调 SLA。
- 网关的 `agents` claim 可能落后于 SLA。本机刚做的变更（建、认领、加或移除共享）在 5 分钟内优先于 claim：新 Bot 立刻对所有者可见，移除的共享立刻失效。
- 多人模式之前就有的 Bot（包括 Main Bot），以及 Main Bot 用工具建的 Bot，在 SLA 里没有所有者，只有超级管理员看得到。超级管理员可以在设置里「Register me as owner」（`claim-bot`，调同一个 `PUT`），之后再共享给别人。本机记下已登记的 Bot（`state.multiuser.registered`），视图里每个 Bot 的 `access.registered` 由它而来。

### 署名

- DSH 把输入框发出的消息记成 `source.rpcId` = 这次提交的请求 id。多人模式下，窗口在会话快照的 `pendingSubmissions` 里一看到新提交，就调 `author` 端点为当前登录的人认领这个 id；`ds-bot` 自己的 `send` 端点在发出之前认领。第一次认领生效，认领要求对这个对话有写权限。名字存在 `bot/authors.json`（最多 2 万条），不进 `state.json`。
- 模型读到的人的消息前面加「[From 名字]」（`llm/stream` 里改写，Session 里的原文不变）。群聊记录里人的行带 `author`，成员读到「名字 (user): …」；群的预览也带名字。Bot 的系统提示多一段「Several people share you」：规则里的「the user」指正在回答的这条消息的作者，按名字称呼人。
- 界面上，别人发的消息在气泡上方显示名字，自己的不显示。投递时，人发出的消息的发送者名字用身份里的名字，不再是 'You'。

### 审计

- 写操作（`write`、`manage`、`create`，以及改团队设置的接口）成功后，不等结果地调 `POST /api/atenea/audit` `{ action, targetType: 'agent' | 'group' | 'team', targetId, detail }`。`detail` 只有字段名和少量枚举值（`role`、`staffUserId` 等），消息只记长度，不记内容和密钥值。审计失败只写日志，从不影响操作。

### 界面

- 只能看的 Bot 和群，输入框换成一张说明卡（`conversation.composer` 链上的一个条目）。
- Bot 设置：reader 看到「View only」，编辑用的卡片禁用；隐私和删除只给所有者；工作文件夹和 Main Bot 卡片只给超级管理员；没登记的 Bot 给超级管理员一张认领卡；所有者有「Sharing」卡片。
- 不是超级管理员的人看不到团队设置页（模型、连接器、能力、用量、密钥、反馈）。

## 不做什么

- 不在 `ds-bot` 里存用户、密码或共享关系；SLA 是唯一来源。
- 不做群级别的共享：群的权限由成员推出来。
- 不按人隔离 Bot 的运行环境：所有 Bot 仍以容器里的同一个系统账号运行。
- 不改 DSH。

## 已知限制

- Bot 在容器里有完整权限：能和一个 Bot 聊天的人，就能让它读写容器里的文件、执行命令、访问网络。目录限制只是 `ds-bot` 工具钩子里的检查（见[隐私 Bot](2026-10-27-private-bots.md)），所以工作文件夹和沙盒权限只给超级管理员。
- Bot 之间照常协作：editor 可以让自己的 Bot 给别的 Bot 发消息、读公开 Bot 的记忆和团队记忆、读它所在群的内容。可见性边界管的是人在界面和接口上能看到什么，不管 Bot 之间的数据流动；需要隔离的 Bot 用隐私 Bot。
- DSH 自己的接口不认识这些身份，由网关按 `session-access` 的回答检查：单次调用（`POST /api/<命名空间>/<方法>`，包括 prompt）、会话列表和搜索、日志下载和上传、mux 上每个流的打开请求，以及消息里对别的会话的 `dsh-session:` 提及。reader 的只读输入框因此不只是界面限制。还剩三个全局流没有按会话过滤：`$events`、`session/control` 和工作区的 `follow` 流把所有会话的元数据（标题、状态、待办、Goal、未答的提问、审批里的工具调用）发给每个浏览器；完整历史和写操作都检查了。关上这一块需要 DSH 能按人接入浏览器（非所有者身份），这是 DSH 的改动（可记入 [DSH 让步总账](2026-10-13-dsh-concessions.md)），细节见网关文档「已知限制」。
- Bot 自己聊天里的审批卡是 DSH 的，不经过 `ds-bot` 的角色检查；在共用服务器上，回答它的 `$events/result` 被网关的路径策略拒绝，审批走 `ds-bot` 的 `approval-answer`。
- 署名靠窗口认领。认领晚于 Bot 读到消息时，那条消息对模型没有名字；DSH 原生界面、手机 App 或其他客户端发的消息没有署名。
- feed 在连接时校验一次身份，到身份过期时断开，窗口用新身份重连。
- 本机的 5 分钟覆盖只在内存里，重启后以网关的 claim 为准。按 email（而不是员工 id）共享时没有本机覆盖，要等网关的 claim 更新。
- 群里的 reader 能看到这个群的全部对话。

## 变更

- 2026-11-05：初版。
- 2026-11-05：加 `session-access` 端点，供网关检查 DSH 自己的会话调用；改写「已知限制」里 DSH 接口那一条（PR feat/gateway-session-guard）。
