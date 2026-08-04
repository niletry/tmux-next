# Claude 事件的锁屏推送通知

## 问题

现在唯一的"提醒"是前端那个 ● 标记:Claude 一轮聊完、且标签页在后台时,浏览器标签标题加 ●。它**只在页面开着时有效**——手机锁屏、划掉 app 就收不到。真实场景是人把任务丢给 tmux 里的 Claude 然后去干别的,需要在**锁屏/app 关着**时被叫回来:会话结束了、一轮聊完在等你、或者 Claude 卡在一个权限确认上。

目标:让这些事件变成手机的**系统推送通知**,锁屏可见,点开跳到对应会话。

## 触发端:Claude hooks → tmux-next

沿用现有 `tmux-next hook` 的做法(它已经装了一个 SessionStart hook 做会话恢复),扩展安装器,并列多装三个 hook,都指向同一个脚本:

| Claude hook | 事件 `event` | 语义 |
|---|---|---|
| `Stop` | `waiting` | 一轮回复结束,在等你 |
| `SessionEnd` | `ended` | 会话结束/退出 |
| `Notification` | `attention` | Claude 需要权限确认或输入(卡住它执行的提醒都归这类) |

**hook 脚本**(一个文件,注册在三个事件下):读 Claude 的 stdin JSON(含 `hook_event_name`、`session_id`、`cwd`、`message`),用 `$TMUX_PANE` 解析出 tmux 会话名(和现有 hook 一样),`curl` POST 到 `http://127.0.0.1:7682/api/notify`,body `{event, session, id, message?}`。

沿用现有 hook 的纪律:不在 tmux(`$TMUX` 空)、tmux-next 没跑、`web-*` 会话、缺 `jq`/`curl` → 一律静默 no-op,绝不拖慢/卡住 Claude。

## 送达端:tmux-next → 手机(Web Push)

### VAPID 身份密钥

首次需要时生成一对 P-256 密钥(ECDSA),存 `~/.tmux-next/vapid.json`(env `TMUX_NEXT_VAPID_PATH` 可覆盖,便于测试)。公钥给前端订阅用,私钥服务端签 JWT 用。一次性,永久复用。

### 订阅

- 前端在用户点"开启通知"时:`Notification.requestPermission()` → 注册 service worker(`public/sw.js`)→ `pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:<VAPID 公钥> })` → 把订阅对象 POST 到 `/api/push/subscribe`。
- 服务端把订阅(`{endpoint, keys:{p256dh, auth}}`)存到 `~/.tmux-next/push-subscriptions/`,一订阅一文件,按 endpoint 的哈希命名。推送返回 404/410 时删除该订阅(端点已失效)。

### 推送

`/api/notify`(hook 调用)→ `notify(event, session, …)`:
1. 按事件生成文案(标题=会话名,正文=事件描述)。
2. 限频(见下)。
3. 遍历订阅,对每个用 Web Push 协议加密发送。

`public/sw.js`:`push` 事件 → `showNotification(title, {body, data:{session}, tag:session})`;`notificationclick` → 聚焦或打开 `terminal.html?target=<session>`。用 `tag=session` 让同一会话的通知自动合并、不叠一堆。

### Web Push 协议实现(手写,不加依赖)

契合本仓库"运行时只有 xterm"的洁癖,用 Bun 的 WebCrypto 手写,新增 `src/web-push.ts`:

- `generateVapidKeys()`:P-256 keypair,导出 base64url。
- `vapidHeaders(endpoint)`:签 ES256 JWT(aud=endpoint 的 origin、exp≤24h、sub=一个 `mailto:`/占位),返回 `Authorization: vapid t=<jwt>, k=<公钥>`。
- `encrypt(subscription, plaintext)`:RFC 8291 —— 生成临时 P-256 keypair,和订阅的 `p256dh` 做 ECDH,用 `auth` 盐 HKDF 派生 CEK/nonce,`aes128gcm`(RFC 8188)加密,拼出带 header 的密文体。
- `sendPush(subscription, payload, vapid)`:`fetch` 到 `endpoint`,带 `Authorization`、`TTL`、`Content-Encoding: aes128gcm`、加密 body;返回状态供上层处理失效订阅。

WebCrypto 提供了全部原语(ECDH P-256、HKDF、AES-GCM、ECDSA)。加密部分纯函数化(输入订阅+明文+确定性的临时密钥),便于单测。

### 限频

`Stop` 可能频繁触发,防轰炸:服务端内存里按会话名记上次推送时刻,**同一会话 30 秒内只推一条**。例外:`ended`(会话结束是终态)不受限频、总是推。

## 接口小结

| 路由 | 方向 | 说明 |
|---|---|---|
| `POST /api/notify` | hook → 服务 | 触发一条通知。**仅接受本机来源**(见安全) |
| `POST /api/push/subscribe` | 前端 → 服务 | 存一个推送订阅 |
| `GET /api/push/key` | 前端 → 服务 | 取 VAPID 公钥 |
| `public/sw.js` | 静态 | service worker |

## 安全

- **`/api/notify` 仅限本机来源**:hook 本就在本机跑。用 `server.requestIP(req)` 判断,非 loopback(`127.0.0.1`/`::1`)一律 403。**尤其因为服务现在可绑 `0.0.0.0`**,不加这条限制,局域网任何人都能伪造通知刷屏。
- **`0.0.0.0` 下的订阅暴露**:绑 `0.0.0.0` 且无认证时,局域网设备也能调 `/api/push/subscribe` 把自己订进来,从而收到含你会话名的通知(信息泄露)。这是既有的"无认证暴露"风险的延伸,不在本功能内解决;正常部署应走反代认证。文档点明。
- 订阅对象含推送端点 URL(敏感),只存本机磁盘。

## 前端

- 一个"开启/关闭通知"入口(放列表页设置区或顶部)。首次点 → 申请权限 + 注册 SW + 订阅。已订阅显示开、可关(取消订阅 + 删服务端记录)。
- 权限被拒/浏览器不支持 → 提示"需在已'添加到主屏幕'的 PWA 里开启"(iOS 限制)。
- 新增 `public/push.js`(注册/订阅逻辑)与 `public/sw.js`。

## 已知约束

- **iOS 只对"添加到主屏幕"的 PWA 送达 Web Push**,普通 Safari 标签收不到。前端明确提示。
- 送达依赖苹果/谷歌/火狐的推送中转站,需要能出网到中转站;经现有反代即可。
- 通知是否"该发"取决于 hook 语义,服务端不判断用户此刻是否正盯着某会话看(无从得知);已开着的页面仍靠 ● 就地提醒,推送是补锁屏那一段。

## 测试

- **纯逻辑单测**:`vapidHeaders`(JWT 结构/aud/exp)、`encrypt`(给定固定临时密钥→确定性密文,可对拍已知向量)、事件→文案映射、限频(同会话 30s 内第二条被抑制、`ended` 不抑制)。
- **集成**:
  - `/api/notify` 非本机来源 → 403;本机 → 202 且触发一次 `sendPush`(注入一个假发送器断言被调、payload 正确)。
  - `/api/push/subscribe` 存/取往返;失效端点(mock 410)→ 订阅被删。
  - hook 安装器:装完 `settings.json` 里有 Stop/SessionEnd/Notification 三项且指向脚本,幂等、备份、不覆盖既有配置(照现有 hook-setup 测试)。

## 不做(YAGNI)

- 按会话静音 / 免打扰时段 / 通知偏好设置。
- 通知里带富交互(直接回复、快捷动作)。
- 多用户/多设备的订阅管理界面(订阅就存着,失效自清)。
- 服务端判断"用户正在看这个会话"从而抑制。
