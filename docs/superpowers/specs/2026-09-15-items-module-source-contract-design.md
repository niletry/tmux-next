# 单是内核模块，Jira 是它的一个数据源：收拢 Items、定型来源契约、退役 Jira 页

## 问题

「单」已经是内核概念（见 2026-09-01 的 spec），Jira 已经通过 `provides` 认领来源（见 2026-09-02 的 spec）。功能上没有缺口，但结构上有三处没断干净，而每一处都会在接第二个来源时变成要改内核的理由：

1. **「数据源」没有归宿。** 模型在 `src/` 根下五个平铺文件（`items.ts`、`session-binding.ts`、`item-lifecycle.ts`、`item-facets.ts`、`item-fields.ts`），三百来行 `/api/items/*` 路由内联在 `server.ts` 里，而来源的分派函数（`collectFacets`、`collectFields`、`runSync`、`refreshFromSource`、`notifyLifecycleChange`）住在 `plugins/handlers.ts`。来源能力和插件的页面能力、设置能力混在同一个 `PluginServer` 类型里，"一个插件 = 一个来源"是隐含假设。
2. **内核还有两处认识 Jira。** `src/item-lifecycle.ts` 的 `deriveSignal` 按字面量找 `jira.prs` / `jira.checks`，状态机的 PR/CI 信号写死在 Jira 的维度名上；`public/items.js` 静态 import `plugins/registry.js` 读 `provides` 来决定画不画刷新按钮，浏览器因此依赖一张写死的插件清单。`src/migrate-items.ts` 是第三处，但它是一次性迁移，本轮只搬位置。
3. **Jira 有一个自己的列表页，做的是首页已经会做的事。** `plugins/jira/public/jira.js` 一千行，画卡片、绑会话、开会话、单条刷新——和首页各画一套，首页多一个能力它就少一个。真正只有它有的两个东西（会话在等你时就地回一句、史诗 chip 可点进 Jira）跟 Jira 无关，是内核能力。

目标：**没有 Jira 插件，首页照常是单列表，本地单照常能建、能挂会话、能归档；有 Jira 插件，它只是往里灌单、叠 chip。** 接第二个来源不改内核一行，Jira 自己的 tab 页退役。

## 已定的取舍

- **一个 worktree 从头做到尾。** 下面的分期是执行顺序，不是合并单元。
- **用户看到的页面基本不变。** 这轮是结构，不是外观。首页新增的两个能力是从 Jira 页搬来的，不是新设计。
- **不加"单上的自定义动作按钮"，不加"自定义渲染块"。** 前者 Jira 页今天没有；后者让插件往首页塞任意 HTML，撞"内核不解释插件内容"的界线。等第二个来源真的需要时再加。
- **外部加载（第三方插件从仓库外装进来）不在本轮。** 它和 CLAUDE.md 的安全决定冲突，需要单独论证；本轮做的"浏览器不再静态 import 清单来判断刷新"是它的前置，但只做到这一步。
- **`migrateJiraBindings` 不删。** 它跟着 `items` 走进新目录（`src/items/migrate.ts`），调用点仍在 `src/index.ts`。它是 2026-09-01 那次搬家的一次性迁移，删掉要先确认没有机器还在旧格式上，那是另一件事。

## 第一部分：`src/items/` 目录

现有五个文件加两段 `server.ts` 里的代码搬进一个目录，**只搬不改**：

```
src/items/
  model.ts       ← src/items.ts
  binding.ts     ← src/session-binding.ts
  lifecycle.ts   ← src/item-lifecycle.ts（本轮唯一改逻辑的文件，见第三部分）
  facets.ts      ← src/item-facets.ts
  fields.ts      ← src/item-fields.ts
  migrate.ts     ← src/migrate-items.ts
  sources.ts     ← 新文件，见第二部分
  routes.ts      ← src/server.ts 里全部 /api/items/* 路由 + itemDetail + advanceAllLifecycles
```

`src/session-history.ts` 不动：它按会话记历史，`historyForItem` 只是其中一个读法。

`routes.ts` 导出一个 `itemsRoutes(req, url): Promise<Response | null>`，`server.ts` 在原来那一段的位置调它一次，返回 `null` 就往下走。路由的**相对顺序原样保留**——`/api/items/bind`、`/api/items/sync`、`/api/items/by-session` 必须排在 `^/api/items/([^/]+)$` 之前，这三个坑各踩过一次，注释一起搬。`src/items-api.test.ts` 已经用 200 断言这个顺序，搬完它得原样通过。

对应的测试文件跟着搬进 `src/items/`，文件名去掉 `item-` 前缀。测试的 import 路径改，断言一条不改——**这一部分的验收就是"改了 import 之后全部现有测试通过"**。

## 第二部分：来源契约 `ItemSourceProvider`

### 类型

```ts
// src/items/sources.ts
export type ItemSourceProvider = {
  /** WorkItem.source.provider 的取值。一个进程内不能有两个来源声明同一个值。 */
  provider: string;
  /** 把这个来源同步一遍（新建/更新单）。显式动作，30s 预算。 */
  sync?(opts?: { full?: boolean }): Promise<SyncResult>;
  /** 只刷新一张单。显式动作，30s 预算。 */
  refreshItem?(ref: string): Promise<void>;
  /** 给单贴 chip。每次画页都跑，300ms 预算，不许发请求。只收到 provider 匹配的单。 */
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
  /** 喂模板的字段。按下按钮才跑，5s 预算。 */
  fields?(item: ItemRef): Promise<Record<string, string>>;
  /** 状态机迁移之后的尽力通知。抛出即失败，内核只记日志。 */
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};
```

五个方法的语义、预算、失败语义**一个都不变**，只是从 `PluginServer` 上搬到一个以 `provider` 为键的对象上。三个超时常量（`ENRICH_TIMEOUT_MS`、`FIELD_TIMEOUT_MS`、`SOURCE_TIMEOUT_MS`）和三个封顶常量跟着搬进 `sources.ts`。

### 插件怎么交出来源

```ts
// plugins/handlers.ts
export type PluginServer = {
  handle?: PluginHandler;
  start?(): void;
  readSettings?(): Promise<Record<string, SettingValue>>;
  writeSettings?(values: Record<string, string | boolean>): Promise<void>;
  runAction?(key: string): Promise<boolean>;
  /** 这个插件带来的数据源，零个或多个。 */
  sources?: ItemSourceProvider[];
  /**
   * 插件级的 enrich：收到**全部**单，不按来源筛。留给不绑定任何来源也想贴 chip
   * 的插件（比如读 git 分支的）。绑定了来源的插件用来源级的 enrich，不用这个。
   */
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
};
```

`sync`、`refreshItem`、`fields`、`onLifecycleChange` 从 `PluginServer` 上**删除**，只在来源上存在。Jira 的 `SERVERS.jira` 变成 `{ handle, start, readSettings, writeSettings, runAction, sources: [jiraSource] }`。

### 分派

`sources.ts` 持有分派，从 `plugins/handlers.ts` 搬来并按来源重写：

- `sourceProviders(): ItemSourceProvider[]`——遍历 `enabledPlugins()`，收集每个已启用插件的 `sources`。`TMUX_NEXT_DISABLE_PLUGINS` 在这一处生效，不再有 `isConsidered`。两个来源声明同一个 `provider` 值时后者被丢弃并打一行日志——不抛，启动不能因为一个插件写错而失败。
- `claimedProviders(): string[]`——上一条的 `provider` 列表。给 `/api/items` 响应用。
- `collectFacets(items, cap)`——来源级 enrich 只传 `source.provider === provider` 的单；插件级 enrich 传全部。净化（限长、tone 白名单、url 只认 http、`item.` 前缀拦截、图标白名单、stage/sortKey 形状）一行不改。合并后按单封顶不变。
- `collectFields(item)`——只问认领了 `item.source.provider` 的那一个来源。无来源的本地单不问任何人。
- `runSync()`、`refreshFromSource(provider, ref)`、`notifyLifecycleChange(provider, ref, from, to)`——查表改为按 `provider` 找来源，失败语义不变（sync 零结果、refresh 404、notify 只记日志）。

这些函数**继续接受注入的来源表作为可选参数**，理由和现在一样：注册表是编译期常量，不注入假来源就没法证明超时和 try/catch 真的兜得住。`src/plugin-enrich.test.ts`、`plugin-fields.test.ts`、`plugin-source.test.ts` 改注入形状，断言不改。

### `provides` 从清单里删除

它存在的唯一理由是浏览器要知道"谁认领了这个来源"。改为：

- `GET /api/items` 响应多一个字段 `providers: string[]`，值是 `claimedProviders()`。
- `GET /api/items/:id` 和 `by-session` 响应同样带 `providers`。
- `public/item-card.js` 的 `claimedProviders()` 不再 import `plugins/registry.js`，也不再请求 `/api/plugins`；它从调用方拿到的响应体里读 `providers`。`refreshButton(item, providers, onChange)` 多一个参数。
- `public/items.js` 和 `public/item-panel.js` 把响应里的 `providers` 递下去。

做完这一步，`public/` 下只剩 `nav.js` 和 `i18n.js` 还 import `registry.js`（tab 和字典），这两处本轮不动。

`src/i18n.test.ts` 的扫描器不认 `provides`，无需改。`plugins/registry.test.ts` 里凡是断言 `provides` 的用例删除，改为在 `sources.ts` 的测试里断言"两个来源撞 provider 时后者被丢弃"。

## 第三部分：状态机不再认维度名

`Facet` 加一个封闭枚举：

```ts
export type Facet = {
  // …现有字段不变
  /**
   * 这条 facet 在单的进度状态机里扮演什么角色。内核只认这一个字段，不看 dim。
   *
   * "pr"：value 是 PR 数，detail 每行一个 PR，行的 tone 是 undefined=open、
   *       "dim"=merged、"warn"=declined。
   * "check"：顶层 tone 是 "ok"=全过、"warn"=有失败；这条 facet 只在真的问到过
   *          检查时才出现——缺席就是"没查到"，不是"过了"。
   */
  role?: "pr" | "check";
};
```

- `collectFacets` 的净化透传 `role`，只认这两个值，别的当没给。**内核自己的 facet 不会有 `role`**，它们是 `item.*` 维度；`role` 是来源说"我这条 chip 是 PR"的方式。
- `deriveSignal` 改为 `facets.find((f) => f.role === "pr")` 和 `role === "check"`。tone 语义不变，只是从注释升级为 `role` 的文档，成为契约的一部分。
- 一张单有多条 `role: "pr"` 时（两个来源都贴了）取第一条。这是今天的行为（`find`），写下来是为了不让它变成暗规则。
- Jira 的 `facetsFor` 在 `jira.prs` 上加 `role: "pr"`，`jira.checks` 上加 `role: "check"`。
- `src/item-lifecycle.test.ts` 里的 fixture 改成带 `role` 的 facet，维度名改成不叫 `jira.*` 的任意名字——这是证明内核不再认 Jira 的那条断言。

## 第四部分：首页开给数据源的扩展点，一张完整清单

写成 `docs/plugin-sources.md`，是给写下一个来源的人看的契约。列在这里的就是全部，不在这里的就没有：

| 位置 | 来源给什么 | 内核怎么画 | 状态 |
|---|---|---|---|
| 单号前的徽标 | `badge: true` 的 facet，带 `icon` | 类型图标；title 列全部徽标维度 | 已有 |
| chip 行 | `dim` / `value` / `tone` / `icon` | 一格文字，颜色按 tone；`dim` 是 i18n 键 | 已有 |
| chip 可点 | `url` | 只认 http/https，新开标签 | **新** |
| chip 明细浮层 | `detail[]`：label / value / tone / url / group / groupUrl / send | 分组列表；有 `send` 的行画"发给会话" | 已有 |
| 卡片头的阶段灯 | `stage: {rank, total}` + `light` | 走过的绿、没到的灰、卡住的红 | 已有 |
| 排序下拉 | `sortKey: {key, rank?}` | 同 key 聚成一个选项 | 已有 |
| 分组 / 筛选 | 无需声明 | 从 chip 数据自动算 | 已有 |
| 状态机信号 | `role: "pr" \| "check"` | 只看 role | **新** |
| 刷新按钮 | 来源实现了 `refreshItem` | 服务端在响应里告诉页面 `providers` | 改 |
| 模板字段 | `fields()`，清单里 `fieldKeys` 列名 | 新建会话页的占位符 | 已有 |
| 设置页 | 清单里 `settings` / `actions` | 表单和按钮 | 已有 |
| 单号链接 | `source.url`，来源在 `ensureItemForSource` 时写 | 单号徽标可点 | 已有 |

**Facet 级的 `url`**：和 `FacetDetail.url` 走同一个 `safeHttpUrl`。`facetChip` 有 `url` 且没有 `detail` 时画成 `<a target=_blank rel=noopener>`；两者都有时 `detail` 优先（chip 是按钮开浮层，链接放进浮层标题旁边，形状同 `groupUrl`）。Jira 在 `jira.epic` 上给史诗的 `browse` 地址。`facetChip` 的三个使用者（首页卡片的 `.facets` 行、表格视图的单元格、单浮层）都不在 `<a>` 里，嵌套合法；会话列表页卡片上的单号 chip 是一个纯 `span`，不经 `facetChip`，不受影响。

## 第五部分：首页要补的两个内核能力

### 会话在等你时，就地看它问了什么、回一句

这是 Jira 页 `openQuestion` 的功能，搬进内核，因为它读的是会话的最后一条消息（`GET /api/sessions/:name/message`）、发的是 `send-keys`（`POST /api/sessions/:name/keys`），两条路由早就在内核里。

- `public/item-card.js` 的 `sessionRow` 在会话状态是 `waiting` 时，在「进入」旁边多画一个「回答」按钮（`items.answer`）。和解绑的 × 一样，按钮在 `.item-session-row` 里、不在 `<a>` 里。
- 点开 `openAnswerSheet(sessionName, onSent)`：标题 + 会话名 + 最后一条消息（Markdown 渲染）+ 一行输入框 + 发送 / 关闭 / 进入终端。发送成功后调 `onSent` 让调用方重画（会话从"等你"变"在跑"）。失败留在浮层里、输入不清。
- `plugins/jira/public/markdown.js` 搬到 `public/markdown.js`，`src/jira-markdown.test.ts` 改名 `src/markdown.test.ts`，断言不改。
- 三处共用 `sessionRow`（首页卡片、终端页顶栏的单浮层、会话列表页的单浮层），所以三处都得到这个能力。会话列表页自己的会话卡片（`list.js`）**不加**——那张卡片的整个 `.card-main` 是进终端的链接，加按钮要重排卡片，超出本轮。
- 新 i18n 键：`items.answer`、`items.answerTitle`、`items.answerLoading`、`items.answerNone`、`items.answerPlaceholder`、`items.send`、`items.sending`、`items.sendFailed`。Jira 的 `jira.asked*` / `jira.reply*` / `jira.send*` 随页面一起删。
- `src/item-card.test.ts` 加：waiting 的会话行有「回答」按钮、working 的没有；浮层能画出消息、发送 POST 到正确的端点、失败不关浮层。

### "另有 N 条 PR 被隐藏"

`onlyKeyedPrs` 过滤掉的 PR 数，现在只在 Jira 页显示。改为 Jira 的 `facetsFor` 在 `jira.prs` 的 `detail` 末尾加一行 `{ label: "另有 N 条 PR 未带本单号", value: "", tone: "dim" }`。不开新扩展点：一行 dim 明细已经能说清。文案在 Jira 插件的字典里（`jira.prHidden` 保留），由插件在服务端翻译——`enrich` 没有语言上下文，用中文。这一条是妥协，记下来：来源侧的服务端文案没有 i18n 通路，本轮不开。

## 第六部分：Jira tab 页退役

退役后 Jira 插件只剩数据源和设置，没有页面。

### 删

- `plugins/jira/public/` 整个目录：`jira.js`、`style.css`、`filter.js`、`refresh-state.js`、`session-name.js`（`markdown.js` 搬走，见上）。
- 对应的测试：`src/jira-filter.test.ts`、`src/jira-refresh-state.test.ts`、`plugins/jira/session-name.test.ts`、`plugins/jira/bindings-shim.test.ts`。
- `/api/jira/issues`、`/api/jira/dev`、`/api/jira/bindings`（GET/POST/DELETE）五条路由，以及它们背后的 `jiraBindingsView`、`claimIssue`、`liveFromKernel`。`/api/jira/config` 保留：设置页不用它，但它是"连的是哪个实例"的唯一读法，留给调试。
- `plugins/jira/plugin.js` 里 `page`、`icon`、`titleKey`，和只有页面用的字典键。
- `src/responsive.test.ts` 扫描的样式表列表里 Jira 那一项自然消失，`src/themes.test.ts` 的色值豁免列表若有 Jira 项也删。

### 清单契约的一处放宽

`Plugin.titleKey`、`icon`、`page` 变成可选：**没有页面的插件不出 tab**。`nav.js` 过滤掉没有 `titleKey` 的插件；`plugins/registry.test.ts` 里"每个插件都有 titleKey/icon"的断言改为"有页面的插件才必须有"。`legacyPaths` 的 301 逻辑不变。

### 旧地址

`/p/jira/` 和 `/p/jira/index.html` 301 到首页 `./`。这不是 `legacyPaths`（那是根目录文件名），是 `server.ts` 插件页面路由的一个分支：清单没有 `page` 也没有 `public/index.html` 的插件，`/p/<id>/` 答 301 到首页——通用规则，不点名 Jira。不带筛选参数：首页的筛选存在 localStorage，不读 URL，为一次书签跳转加一条 URL 参数通路不值得。

### 插件内部拆分

`plugins/jira/server.ts` 985 行拆成：

```
plugins/jira/
  server.ts     ← 只剩 PluginServer 对象的拼装：handle（config 路由）、start、settings、sources
  source.ts     ← ItemSourceProvider 实现：sync / refreshItem / enrich / fields / onLifecycleChange
  cache.ts      ← 四份缓存（JQL 结果、按 key 的 issue、按 id 的 dev、仓库名）和 issues() / dev() / refreshIssue()
  facets.ts     ← facetsFor 及图标、tone、typeKey、epicSummaryOf、prGroupLabel
  settings.ts   ← readSettings / writeSettings / runAction
```

已有的 `client.ts`、`dev.ts`、`sync.ts`、`sync-state.ts`、`jql.ts`、`writeback.ts`、`status-stage.ts`、`adf.ts`、`config.ts` 不动。测试文件按现有边界已经分好（`enrich.test.ts`、`sync.test.ts`、`refresh-item.test.ts`、`issue-cache.test.ts`、`settings.test.ts`……），只改 import。

## 数据流（改完之后）

```
浏览器 items.js ──GET /api/items──▶ src/items/routes.ts
                                       ├─ model.readItems / binding.resolveBindings
                                       ├─ facets.kernelFacets            （item.* 维度）
                                       ├─ sources.collectFacets          （按 provider 分发给来源的 enrich）
                                       └─ sources.claimedProviders       （响应里的 providers）
                                                │
                                                ▼
                                 plugins/handlers.ts SERVERS[id].sources[]
                                                │
                                                ▼
                                 plugins/jira/source.ts（enrich 读 cache.ts，不发请求）
```

`POST /api/items/sync` → `sources.runSync()` → 每个来源的 `sync()` → `advanceAllLifecycles()` → `lifecycle.advanceLifecycle`（按 `role` 读信号）→ `sources.notifyLifecycleChange` → 来源的 `onLifecycleChange`。

## 失败边界

全部沿用现有语义，没有一条新的：

- 来源的 `enrich` 抛 / 超时 / 返回非对象 → 这个来源这轮没有 chip，首页照常。
- `sync` 抛 → 零结果。`refreshItem` 抛 / 无来源 / 来源没实现 → 同一个 404。
- `onLifecycleChange` 抛 → 记日志，已落盘的状态不撤销。
- 两个来源撞 `provider` → 后者丢弃，记日志，不抛。
- `role` 不是两个合法值之一 → 当没给，状态机看不到这条 facet。
- 「回答」浮层：读消息失败显示 `items.answerNone`；发送失败留在浮层里、按钮恢复可点。

## 测试

- **第一部分**：不写新测试。验收是 `bun run test` 在只改 import 之后全绿（除 CLAUDE.md 记的那条 9 失败 / 1 错误的已知尾巴）。
- **第二部分**：`src/items/sources.test.ts` 承接 `plugin-enrich`、`plugin-fields`、`plugin-source` 三个文件的用例，注入形状改为 `ItemSourceProvider[]`。新增：来源级 `enrich` 只收到自己 provider 的单；插件级 `enrich` 收到全部；两个来源撞 provider 后者被丢弃；`claimedProviders` 随 `TMUX_NEXT_DISABLE_PLUGINS` 变化。`src/items/routes.test.ts`（原 `items-api.test.ts`）加：三个响应都带 `providers`。
- **第三部分**：`src/items/lifecycle.test.ts` 的 fixture 全部改成不叫 `jira.*` 的维度名加 `role`；加一条"没有 `role` 的 facet 即使叫 `jira.prs` 也不算信号"。`sources.test.ts` 加 `role` 净化。
- **第四部分**：`src/item-card.test.ts` 加 chip `url` 的三种情况（只有 url、只有 detail、都有）。
- **第五部分**：见上。`src/markdown.test.ts` 改名不改断言。
- **第六部分**：`src/plugin-routing.test.ts` 加"没有页面的插件 `/p/<id>/` 答 301 到首页"；`plugins/registry.test.ts` 的 titleKey 断言改条件；`src/i18n.test.ts` 靠删字典键自然收敛，死键扫描会指出漏删的。`src/public-parses.test.ts` 扫 `public/` 的列表自然少一个目录。
- **手工**：在手机上把 Jira 页原来的每个动作在首页过一遍：筛史诗、筛状态、看 PR、看检查、点 PR 链接、点史诗链接、开新会话、挂已有会话、解绑、回答等你的会话、单条刷新、全部同步、`/p/jira/` 书签跳转。

## 不做

- 外部加载。单独 spec。
- 单上的自定义动作、自定义渲染块。等第二个来源。
- 会话列表页（`list.js`）自己的会话卡片上的「回答」按钮。卡片要重排。
- 来源侧服务端文案的 i18n。只有"隐藏 PR"一条受影响，先用中文。
- `nav.js` / `i18n.js` 对 `registry.js` 的 import。它们只读清单的 tab 和字典，外部加载那一轮再动。
- 删 `migrateJiraBindings`。先确认没有机器在旧格式上。
