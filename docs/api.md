# HTTP API：从外部驱动 tmux-next

这份文档是给**写第二个客户端的人**看的——手机原生端、桌面端、CLI，或者任何想在浏览器之外管理这台机器上 tmux 会话的程序。内置的 Web 页面用的就是下面这些接口，没有第二套私有通道。

## 先读这一节

**这套 API 没有任何鉴权，而且它等价于一个 shell。**

没有登录、没有 token、没有会话校验。谁发的请求就给谁答。这不是待办事项，是设计：一个能创建会话、往 pane 里打字、读屏幕内容的接口，本来就等于以启动它的那个用户的身份执行命令，在前面加一道自己的登录页只是表演。服务默认绑回环，并且假定前面有一个反向代理负责 TLS 和认证，详见 [`SECURITY.md`](../SECURITY.md) 与 [`deploy.md`](deploy.md)。

由此得出三条给客户端作者的结论：

- **你的凭据是代理的凭据。** 认证发生在代理那一层，不在这里。客户端要做的是带上代理认的东西（Cookie、Authorization 头、JWT，取决于部署），而不是找这里的登录接口——没有。
- **别把 base URL 硬编码成 `127.0.0.1`。** 应用可能挂在反代的某个子路径下，所有路径都要相对解析。
- **`--host` 把服务绑宽是有人明确要这么做时才做的事。** 绑到 `0.0.0.0` 就绕过了代理，等于把 shell 挂在网上。

唯一的例外是 `POST /api/notify`：它只接受回环来源，非回环一律 403。它是给本机 hook 脚本用的，不是给客户端用的。

## 契约的稳定程度

**现在还没冻结。** 这是一份分五期的改造里第一期的产物（设计见 [`superpowers/specs/2026-09-17-headless-session-api-design.md`](superpowers/specs/2026-09-17-headless-session-api-design.md)），第五期结束时才冻结。冻结之后字段只增不减、不改含义；在那之前会有破坏性变更，每次都会在发布说明里逐条列出。

**用能力协商，不要用版本号猜。** 真正会发生的不一致是客户端比服务端新：服务端是 npm 包由用户自己升级，客户端要过应用商店审核。所以先问一句：

```
GET /api/capabilities
```

```json
{
  "version": "2.3.0",
  "build": "3cd3f42",
  "events": ["session.created", "session.ended", "session.renamed",
             "session.turn", "session.attention"],
  "streamEvents": ["resync"],
  "includes": [],
  "features": ["sse"]
}
```

`features` 里只会出现**已经实现**的东西。一个提前写上的名字比没有这个端点更糟，因为客户端会据此走上一条不存在的路径，而它本可以降级。所以看不到某个名字就当它不存在，别按版本号推断。

## 通用约定

| 约定 | 说明 |
|---|---|
| 路径 | 全部相对于应用根，不要假定挂在域名根下 |
| 时间 | epoch **秒**，不是毫秒 |
| 成功无内容 | `204`，响应体为空 |
| 失败 | `{"error": "<原因>"}`，原因是一个短标识符而非给人读的句子；少数早期路由返回纯文本 |
| 字符集 | 全 UTF-8。会话名可以含 CJK，放进路径时要 percent-encode |

## 会话

会话是这套接口的主体：一个 tmux 会话，连同跑在里面的 agent。

### 列出全部

```
GET /api/sessions
```

返回 `{ sessions, items, facets }`。`items` 和 `facets` 是内置首页画卡片用的，客户端可以忽略（见下面「单」一节）。`sessions` 的每一项：

| 字段 | 含义 |
|---|---|
| `name` | 会话名，也是所有单会话路由的键 |
| `sessionId` | tmux 内部 id，形如 `$7`。跨改名不变，跨 tmux server 重启会重排 |
| `path` | 会话打开时的目录。pane 里 `cd` 不会改变它 |
| `attached` | 是否有客户端附着 |
| `windowWidth` / `windowHeight` | 当前窗口尺寸 |
| `lastActivityEpoch` | 最后一次**可见内容变化**的时刻 |
| `turn` | `"waiting"` / `"working"` / `null`，从 transcript 的 `stop_reason` 读出 |
| `idle` | 屏幕上是否有空闲标记 |
| `pinned` | 是否置顶 |
| `agent` / `agentLabel` / `version` | 跑的是哪个 agent 及其版本，都可能为 `null` |
| `claudeId` | 绑定的 Claude 会话 id，可能为 `null` |
| `task` | transcript 里最近一次被要求做的事，可能为 `null` |
| `lastAction` | 最近一次工具调用及其时刻，可能为 `null` |
| `preview` | 屏幕末尾几行 |
| `pendingInput` | 输入框里已经打了但没提交的内容，可能为 `null` |
| `itemId` | 绑定的单，可能为 `null`。契约外字段 |

**判断"这个会话在等我还是在跑"，规则是固定的：`turn` 优先，为 `null` 时才看 `idle`。** 两个字段都留着不是历史包袱——`turn` 读的是记录格式，准；`idle` 认的是 TUI 画面，会随 agent 改版失效，但它是**没有 transcript 的会话**（不是 Claude，或没有绑定记录）唯一的信息源。反过来写会在一个刚跑起来、屏幕上还留着上一轮空闲标记的会话上说错，而那恰好是最需要说对的时刻。

**判断"卡住了没有"不需要新字段**：`turn` 是 `working` 而 `lastActivityEpoch` 很久没动，就是信号。多久算卡住是客户端的判断，服务端只给事实。注意 `lastActivityEpoch` 盖的是可见内容变化，所以一个在刷进度条的会话会一直刷新它，而一个真的挂死的不会。

### 创建

```
POST /api/sessions
{ "dir": "/path/to/project" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `dir` | 是 | 会话的工作目录 |
| `name` | 否 | 会话名。撞上已存在的会话时**复用它而不是新建** |
| `agent` | 否 | agent id，取值见 `GET /api/agents`。未知值直接 400，不会静默回落 |
| `skipPermissions` | 否 | 只有 Claude Code 支持 |
| `resume` | 否 | 恢复一次过去的对话，id 必须匹配 `[A-Za-z0-9-]{1,64}` |
| `initialInput` | 否 | 会话起来后替你敲进去的第一行 |

返回 `{ name, created }`。**`created` 为 `false` 意味着名字撞车、复用了已有会话**，这是带名字创建天然幂等的原因——重试多少次都只有一个会话。

`initialInput` 有两条语义必须知道，否则会写出很难查的 bug：

- **它是不等待的。** 会话建好就返回，注入在后台进行，失败一律无声。因为等 agent 就绪可能要二十秒，把响应压在那里等于让人盯着转圈的按钮。
- **等不到就放弃发送，绝不照发。** 注入前会等 agent 到达可接收输入的状态；超时意味着它可能还在装依赖，或者停在「信任这个目录吗」的确认框上。把文字打进那个状态不会响亮地失败，它会安静地成功，作为对屏幕上那个确认框的回答。同理 `created` 为 `false` 时也不注入——往一个正在跑的会话里敲字是错的。

错误：`baddir`（目录不存在或不可用）、`invalid`、`badagent`、`empty` / `reserved`（名字非法）、`failed` / `startfailed`（500）。

### 其余单会话操作

```
DELETE /api/sessions/<name>              → 204
POST   /api/sessions/<name>/rename       { "name": "新名字" }   → { "name" }
POST   /api/sessions/<name>/pin          { "pinned": true }     → 204
POST   /api/sessions/<name>/keys         { "text": "一行字\n" } → 204
GET    /api/sessions/<name>/message      → { "text": string | null }
```

- **删除会连带杀掉里面的每一个进程。** 目标名以 `web-` 开头的一律拒绝（403），那是本服务自己的一次性挂载会话。会话不存在是 404。
- **`/keys` 收的是文本，不是按键。** 名字在说谎，见文末「已知的粗糙处」。它没有引入任何新权限：任何能碰到这个服务的人本来就能通过 `/ws` 附上去随便打字，这条路只是省掉了为发一行字而建挂载会话、附控制客户端、调窗口尺寸那一整套。
- `/message` 给的是这个会话最后说的那段话（Markdown），用来做「它在问你什么」那种界面。不是 Claude、或没有绑定记录时返回 `null`。

### 恢复

```
GET  /api/restorable        → [{ session, id, cwd }]
POST /api/restore           { "sessions": ["a", "b"] }  → { restored, results }
```

不带 body 的 `POST` 表示恢复全部可恢复的。

## 事件流

**别轮询。** `GET /api/sessions` 为每个会话起一次 `capture-pane` 子进程，代价按会话数线性增长；订阅事件流，状态一变就会告诉你。

```
GET /api/events
Accept: text/event-stream
```

标准 SSE。每条事件是同一个信封：

```
id: evt_b475dd29_1
event: session.created
data: {"type":"session.created","session":"my-project","data":{"sessionId":"$171","path":"/x","agent":null,"agentLabel":null},"id":"evt_b475dd29_1","seq":1,"at":1789691094}
```

| 事件 | 何时发 | `data` 里有什么 |
|---|---|---|
| `session.created` | 出现了没见过的会话 | `sessionId`, `path`, `agent`, `agentLabel` |
| `session.ended` | 会话消失了 | `sessionId` |
| `session.renamed` | id 不变名字变了 | `sessionId`, `previousName` |
| `session.turn` | 轮次状态变化 | `sessionId`, `turn`, `previous` |
| `session.attention` | agent 主动要人（权限询问等） | `message` |

**`id` 和 `seq`不是冗余的。** `id` 让你认出重复投递，`seq` 让你发现缺口——跳号就是漏了。`id` 由 `seq` 加上一个**每进程随机的启动标识**拼成，所以服务端重启之后你手里的旧 id 不会指向新进程里的另一条事件。

**只有状态真的变了才会有事件。** 去重不是一套机制，是比对状态的结果。所以你不会收到"没变化"的心跳式事件，也不该指望用事件流来确认某个会话还活着。

### 重连

带上 `Last-Event-ID`（浏览器的 `EventSource` 自动带）。两种结果：

- 服务端能补上 → 把你漏掉的事件逐条发来。
- 服务端补不上 → 先发一条 `event: resync`，**这意味着你必须重新拉一次 `GET /api/sessions` 重建状态**，不能假装无事发生。

触发 `resync` 的原因有四种（id 认不出、来自别的进程、缺口已被挤出缓冲、服务端在你断线期间根本没在观察），但它们合并成同一个答案，因为你的处置完全一样。补发缓冲按时间保留，大约五分钟。

**`resync` 只走 SSE，不是会话事件。** 它说的是这条连接的事实，不会出现在别处。

### 连接细节

- 连上会立刻收到一个 `retry: 3000` 和一个注释帧。这是有意的：不写字节的话响应头要等到第一条事件才发出去，安静的机器上那可能是十五秒后，你的连接超时会先到。
- 安静时每 15 秒一行 `:ping` 注释，用来穿过会掐死空闲连接的代理和移动网络。
- **服务端只在有人订阅时才轮询。** 最后一个订阅者离开就停，回到几乎不耗 CPU 的静息状态。这是为什么断线重连期间的变化会走 `resync` 而不是补发。

### 反代必须关缓冲

这是部署侧最容易踩的坑：反代默认会攒够一块再吐，事件流会变成几十秒一批，看起来完全像服务端不发事件。Caddy 需要在对应的 `reverse_proxy` 上设 `flush_interval -1`。

## 终端

终端不是 REST，是 `/ws` 上的 WebSocket。

**分帧规则：二进制帧是 pane 的输出字节，文本帧是 JSON 控制消息。**

客户端发（文本帧）：

```json
{ "t": "open",   "target": "会话名", "rows": 40, "cols": 120 }
{ "t": "keys",   "hex": "1b 5b 41" }
{ "t": "resize", "rows": 50, "cols": 100 }
```

- `open` 会先关掉这个 socket 上已有的会话，**一个 socket 同时只挂一个**。
- `keys` 是空格分隔的十六进制字节，和 `/api/sessions/<name>/keys` 的文本语义不同。
- 尺寸：cols 20–1000（缺省 80），rows 5–500（缺省 24）。**越界是钳制，缺失是回落到缺省**——省略一个维度是在说「没有偏好」，把它钳到最小值会给你一个 20 列的窗口。

服务端发：

- 二进制帧 —— pane 输出。
- `{ "t": "error", "message": "..." }` —— 目前唯一的控制消息。

**打开之后收到的第一批字节是一个 seed，它同时还原内容和终端模式，客户端收到后不得再自行清屏。** `capture-pane` 只给文本，seed 里的清屏序列会把模式一起清掉，所以里面还重放了鼠标跟踪的 DECSET。少了这一步，一个用鼠标的程序回来之后滚轮会静默失效。

两个当前的粗糙处，客户端要自己扛：

- **会话结束时服务端直接关闭 socket，不发原因帧。** 所以「会话死了」和「网断了」你分不出来，重连循环只能盲目重建。
- **窗口尺寸是分组共享的。** 同一个目标上的两个客户端会互相抢尺寸，这是已知行为。

## 单（work item）

单是「工作单元」，一张单可以挂多个会话。`GET /api/items` 返回 `{ items, bindings, sessions, facets, providers }`，还有创建、绑定、解绑、归档、同步、刷新等路由。

**这一块目前不在对外契约里。** 它是内置首页的形状，会跟着后面几期变。想用可以用，但别指望它稳定。真要接，先读 [`plugin-sources.md`](plugin-sources.md)。

## 其他有用的读接口

```
GET /api/version       → { version, build }
GET /api/agents        → { agents: [{ id, label, available, supportsSkipPermissions, supportsResume }] }
GET /api/directories   → { home, recent }
GET /api/dirs?path=    → { ok, path, parent, entries: [{ name, path }] }
GET /api/history?dir=  → { conversations }
GET /api/templates     → { templates, fieldKeys }
```

`GET /api/agents` 的 `available` 是通过登录 shell 探出来的，不是查表：一个服务端看得见而登录 shell 看不见的 agent，建出来的会话会立刻消失。

新建目录用 `POST /api/dirs`，注意它收的是**父目录加名字**，不是一个完整路径：

```
POST /api/dirs
{ "parent": "/Users/me/projects", "name": "新目录" }   → 201 { path }
```

错误：`badparent`（父目录不是字符串或不存在，400）、`exists`（409）、`failed`（500）。

## 往会话里传文件

```
POST /api/upload-file
Content-Type: multipart/form-data
  file=<文件>  session=<会话名>
```

返回 `{ path }`，是文件落在**该会话自己的工作目录**里的绝对路径。典型用法是把这个路径再敲回 prompt 里，让会话里的工具去读它。

上限 20 MiB，按 `Content-Length` 先拒一次再按实际字节拒一次，超了返回 413。空文件 400，会话不存在 404，文件名不安全 400。

另有 `POST /api/upload` 收图片并存到固定目录，是内置页面粘贴截图用的，第二个客户端一般要的是上面那个。

## 明确不在契约里的

- **`/api/theme`、`/api/language`、`/api/asr`、`/api/key-usage`** —— 内置 Web 页面的本机偏好。第二个客户端应该有自己的一套，不要读写这些。
- **`/api/plugins/*`** —— 插件的设置与动作，形状由各插件的 manifest 决定。
- **`/api/notify`** —— 回环专用，给本机 hook 脚本用。
- **`/api/push/*`** —— 浏览器 Web Push 订阅。原生客户端用平台自己的推送通道。

## 已知的粗糙处

写下来是因为它们会绊到你，而且在契约冻结前会被修掉：

- **`/api/sessions/<name>/keys` 收的是文本。** 名字来自历史。计划是拆成 `/input`（文本）和 `/keys`（十六进制字节，与 WebSocket 对齐）。
- **`/api/dirs` 和 `/api/directories` 是两个不同的东西。** 前者浏览目录加新建目录，后者返回 home 和最近用过的目录。名字像到几乎不可能不搞混。
- **没有 `GET /api/sessions/<name>`。** 这个路径上只挂了 DELETE，想查一个会话必须拉整张表自己过滤。
- **列表不支持过滤。** `?state=waiting` 这类参数还没有。
- **没有结构化的 transcript 读接口。** 想判断卡没卡住、想看 token 用量，目前只能自己去读磁盘上的 JSONL，那是私有路径不是接口。
