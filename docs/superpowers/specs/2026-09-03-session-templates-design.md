# 会话模板：从一张单开会话时，决定会话名与首条输入

2026-09-03

## 问题

首页的一张单上按 ＋ 会跳到 `new.html?item=<id>`（`public/items.js:406`）。它传的只有单号：
会话名要自己敲，而单的标题、单号、状态、描述正文全都在手边却用不上。会话建完之后，
第一句话还得再打一遍 —— 而那句话在同一类工作里几乎每次都是同一个形状。

要的是：选一个模板，会话名和首条输入一起被填好，可改，然后一次建出来。

## 不做什么

- 不做按 provider 分组的模板范围。一份全局清单，所有模板对所有单可选，取不到的字段渲染成空。
- 不预置任何默认模板。空清单 = 今天的行为一字不差，第一个模板由用户在设置页手建。
- 不做占位符默认值语法（`{key?兜底}`）。空值靠"整行为空就删行"这一条规则处理，见 §3。
- 不在没有单的场合（会话列表点 ＋）提供模板。没有单就没有字段，每个占位符都会渲染成空。

## §1 磁盘状态：`templates.json`

```ts
type SessionTemplate = {
  id: string;      // tpl-<base36>，跟 item 的 id 同一种生成法
  label: string;   // 选择器上显示的名字
  name: string;    // 会话名模板
  input: string;   // 首条输入模板，可多行、可为空
};
```

路径 `TMUX_NEXT_TEMPLATES_PATH`，否则 `~/.tmux-next/templates.json`。**在函数里现读，不在模块
加载时捕获** —— 测试要能先设 env 再调用，这是本仓库每一处磁盘状态的既定规矩。

`readTemplates()` 是全函数：坏文件读成 `[]`，坏记录逐条丢掉，绝不抛。写走 `serialized` +
`writeJsonAtomic`。整套照 `src/items.ts` 的形状，不发明新的。

上限：50 个模板、label 60 字、name 200 字、input 4000 字。

空清单是零成本、零回归的：创建页不画选择器，也不多发一次请求。

## §2 插件契约：`fields(item)`

```ts
export type PluginFieldSource = (item: ItemRef) => Promise<Record<string, string>>;
```

**单条，不是批量** —— 跟 `enrich(items[])` 相反。`enrich` 批量是因为它服务的是一次画整页；
`fields` 只在一张单上被按下，批量除了让插件为 49 张不相干的单多做功没有别的作用，而单条
还让插件能发一次针对性请求（Jira 拿描述正文正是 `/issue/{key}` 一发）。

`plugins/handlers.ts` 的 `PluginServer` 加一个可选 `fields`；`FIELD_SOURCES` 跟 `ENRICHERS`
一样从 `SERVERS` 推导，不另立一张表。`collectFields()` 的安全阀逐条照抄 `collectFacets`：

1. `isConsidered` 过滤（`TMUX_NEXT_DISABLE_PLUGINS` 的唯一闸门）
2. `Promise.race` 硬超时
3. `try/catch`
4. 返回值不是对象就整份丢弃
5. 值截到 `MAX_FIELD_LEN = 4000`
6. **键名不许以 `item.` 开头**
7. 合并后按单封顶 `MAX_FIELDS_PER_ITEM = 12`

失败语义只有一种：**拿不到就当没有**，占位符渲染成空。

`FIELD_TIMEOUT_MS = 5_000`，一个新常数。不复用 `ENRICH_TIMEOUT_MS`（300ms）也不复用
`SOURCE_TIMEOUT_MS`（30s）：300ms 是为"每次页面加载都跑"设的，逼插件读缓存，而 `fields` 是
用户按下按钮才走的一次显式动作，本来就该允许一次真实的网络往返；30s 是整批同步的预算，
而这里有个人正盯着一个还没填上的输入框。

`collectFields` 把 sources 表作为**可注入参数**、真表做默认值 —— 理由跟 `collectFacets`
一模一样：注册表是编译期常量，不注入就没有任何办法证明第 2、3 条安全阀真的会触发。

### 内核字段走同一条路

`src/item-fields.ts`（纯函数、无 IO）产出 `{item.title}` `{item.ref}` `{item.url}`
`{item.provider}` `{item.tags}` `{item.id}`，与插件字段合并成一张平表。

于是 `item.` 这个命名空间的含义是干净的一句话：**内核的字段在这里，插件不许进来**。它跟
`collectFacets` 里那条 `dim.startsWith("item.")` 是同一个命名空间、同一个理由，区别只在这次
内核真的往里放东西。模板语法因此不需要知道哪个键是谁产的 —— 跟 `Facet.dim` 是同源的设计。

## §3 模板语法与渲染：`src/template.ts`

纯函数 `render(template, fields) → string`。占位符 `{key}`，key 匹配 `[a-zA-Z0-9._-]+`。
不认识的键、空值，一律渲染成空串 —— 不留 `{}`，不报错。

一条额外规则，因为 input 是多行的：**渲染后整行只剩标点和空白就删掉这一行**。

没有它，`史诗：{jira.epic}` 在一张没挂史诗的单上会留下"史诗："这么半句话，而这正是模板最
常见的翻车方式。有了它，模板可以放心地一行写一个可选字段。

### 会话名多走一步：`sanitiseName()`

**必须在服务端。** `.` 和 `:` 是 tmux 的 `session:window.pane` 分隔符
（`UNTARGETABLE`，`src/tmux/session-create.ts:17`），带上就是一个连 kill 都 kill 不掉的会话；
`web-` 是本应用挂载会话的保留前缀。这两件事是服务端的事实，浏览器不该复述。

折叠空白为 `-` → 剔除 `[.:]` → 截到 64 → 去首尾 `-`。结果为空或撞上保留前缀就返回 `null`，
等于"没提供名字"，服务端按目录生成 —— 跟今天的默认路径完全一致。

### 截断发生在渲染时

`render` 的输出截到 `MAX_TEXT`（2000，`src/tmux/send-text.ts` 的既有上限），**不是发送时**。
这样创建页框里那段文字就是最终会敲进去的那段。所见即所发；反过来预览会撒谎。

## §4 路由与创建流程

| 路由 | 作用 |
|---|---|
| `GET /api/templates` | 整份清单 |
| `PUT /api/templates` | 整份替换 |
| `POST /api/items/:id/render` | body 收 `{name, input}` 两段**模板串**，回两段**渲染结果**；单不存在 404 |

`PUT` 整份替换而不是逐条 CRUD：设置页就是一个编辑器，而逐条 CRUD 是为多写者准备的，这里
只有一个人和一台机器。

`render` 收模板串而不是 `templateId`，是为了让它跟"模板存在哪"完全解耦：设置页因此能边编辑
边看真实预览、不必先存盘；创建页也不必担心自己手上的模板和服务端读到的是不是同一份。

### `POST /api/sessions` 加可选 `initialInput`

收的是**最终文本**（≤2000），不是模板。服务端不再渲染一次 —— 再渲染一次就会把用户在框里
的修改悄悄丢掉。

服务端建完会话**立刻返回响应**，然后 fire-and-forget 一个 `primeSession()`，`try/catch` 包住，
跟 `startPlugins()` 同一种姿态：它失败不该连累任何人。

### `src/tmux/prime.ts`

两层。纯函数 `waitForReady(capture, marker, budget)` 注入 capture 函数因此可以无头测；外壳每
250ms `capture-pane` 一次，`agent.screen.idleMarker` 命中就 `sendText`，`PRIME_TIMEOUT_MS =
20_000` 耗尽就**放弃，不发**。

放弃而不是"超时也发"，是这一节唯一需要辩护的决定。超时的含义是 agent 还没到能收输入的
状态 —— 还在装依赖、卡在"信任这个目录吗"、或者根本没起来。往那里敲一行字不是无害的：
它会变成对一个确认框的回答。而不发的代价很小 —— 那段文字刚刚还在创建页的框里，用户看得见
它没进去，手动补一次远比误答一个 y/n 便宜。

顺带一个必然会遇到的情形：不勾 skip-permissions 时 claude 常常先问信任目录，
`idleMarker`（"等你输入"）在那个画面上不会命中，于是自然走到超时放弃 —— 正是想要的行为。

**`created === false` 时不 prime。** `createSession` 会复用同名的既有会话，往一个正在跑的
会话里敲字是错的。

## §5 两个页面

### 创建页 `public/new.js`

模板清单非空、**且** URL 带 `?item=` 时，在目录列表和名字框之间插一行模板 chips（复用
`.agent-chip` 那套），第一个是默认选中的"不用模板"。选中某个 → 打一次 `render` → 名字框填入
结果，下面展开一个多行 `textarea` 填首条输入。

两个框都可改。名字框跟今天的 `?name=` 是同一种性质：默认，不是决定。

切换模板**直接覆盖**两个框，包括手改过的内容。选模板这个动作的意思就是"改用这一套"，
为它加一道确认，是在为一个用户刚刚亲手表达的意图设障。

没有 `?item=` 时不画选择器（见"不做什么"）。

### 设置页 `public/settings.js`

新增一节，形状跟已有的 `pluginSection` 同族：列出模板，每条展开是 label / name / input 三个
框加一个删除，底下"新建"，保存打 `PUT`。

**占位符怎么让人知道有哪些可填**，是这一节唯一的设计问题。内核那六个是常量，直接列；插件
的是开放集合，而设置页绝不能有一张写着 `jira` 的表。所以清单（`plugins/types.ts` 的
`Plugin`）加 `fieldKeys?: string[]`，跟 `facetDims` 是同一步棋，连理由都一样：凡是内核需要
知道、又不该写死的东西，由插件在清单里声明。设置页从同构的 `registry.js` 读出来，画成可点的
chips，点一下把 `{jira.description}` 插进光标处。

键名**不翻译、原样显示** —— 模板作者要打的就是这串字，给它配一份 i18n 只会让人对不上号。

## §6 测试

无头的（大头）：

- `src/template.test.ts` —— 渲染、未知键、空值删行、截断到 2000；`sanitiseName` 的 `.` / `:` /
  `web-` 前缀 / 折叠后为空退回 `null`。
- `src/item-fields.test.ts` —— 内核六字段，含 `source` 为 null 的本地单。
- `src/plugin-fields.test.ts` —— 照 `src/plugin-enrich.test.ts` 那份：一个会抛的假插件、一个
  永远卡住的假插件，证明 5s 超时和 try/catch 真的兜得住；再证 `item.` 前缀被拒、值截断、
  条数封顶（合并后封顶，不是每插件封顶）。
- `src/templates-api.test.ts` —— 读写往返、坏 JSON 读成空、上限。
- `src/prime.test.ts` —— `waitForReady` 注入假 capture：命中即发、耗尽预算即放弃。
- `src/new-page.test.ts` 扩 —— happy-dom 挂载创建页：有模板画选择器、选中后两个框被填、
  无 `?item=` 不画。这是 CLAUDE.md 明写的要求（"会渲染的浏览器模块必须有渲染它的测试"），
  不是可选项。DOM shim 必须还原它替换掉的全局对象。
- `src/settings-page.test.ts` 扩 —— 模板一节的增删改。

真驱动 tmux 的只留一条 integration：建一个会话、prime 一次、`capture-pane` 读回那行字确实
在里面；外加 `created:false` 不 prime。它自己清理自己建的会话，按 `=<name>` 精确 kill，
名字带 `web-<pid>-` 之外的自有前缀以便断言收窄到本进程。

`src/i18n.test.ts` 和 `plugins/registry.test.ts` 会自动覆盖新键与新能力，不用改。

## 文档

- CLAUDE.md 加一段：为什么 `fields` 是单条而 `enrich` 是批量、为什么超时是放弃而不是照发、
  `item.` 命名空间那条互补规则（内核的字段在里面，插件的 facet 维度不许进来）。
- README.md 与 README.zh-CN.md 同步 —— 行为变了，两份都要改。
