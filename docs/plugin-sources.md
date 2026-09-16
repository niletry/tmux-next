# 数据源契约：怎么给首页接一个新来源

首页（`public/items.js`）画的是**单**（work item）。单是内核概念，住在 `src/items/`；一张单要么是本地建的（`source` 为 `null`），要么背后有一个外部来源（`source` 为 `{ provider, ref, url? }`）。Jira 插件是今天唯一的来源实现，但内核里没有任何一处写着 `jira` —— 它只按 `source.provider` 这个字符串查表。

这份文档是给**写下一个来源的人**看的：契约有哪些方法、各自多少预算、失败了会怎样、首页开了哪些扩展点。**列在这里的就是全部，不在这里的就没有。** 想让首页多画一样东西，那是要先改内核、先改这份文档的事，不是插件自己能加的。

## 一、契约本身

```ts
// src/items/sources.ts
export type ItemSourceProvider = {
  provider: string;
  sync?(opts?: { full?: boolean }): Promise<SyncResult>;
  refreshItem?(ref: string): Promise<void>;
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
  fields?(item: ItemRef): Promise<Record<string, string>>;
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};
```

`provider` 之外的五个方法全是可选的。一个只会灌单、不贴 chip 的来源，只实现 `sync` 就够用了。

**一个进程里两个来源不能认领同一个 `provider` 值**。撞了的话后者被丢弃并打一行日志——不抛：一个插件写错了名字，不该让整个服务起不来。

### 五个方法

| 方法 | 什么时候跑 | 预算 | 允许发请求吗 |
|---|---|---|---|
| `sync(opts)` | 用户按「同步」，或插件自己在 `start()` 里发起 | `SOURCE_TIMEOUT_MS` = 30s | 是，这是它的本职 |
| `refreshItem(ref)` | 用户在一张单上按「刷新」 | `SOURCE_TIMEOUT_MS` = 30s | 是 |
| `enrich(items)` | **每一次画首页** | `ENRICH_TIMEOUT_MS` = 300ms | **不**。只读缓存 |
| `fields(item)` | 用户在一张单上挑了一个会话模板 | `FIELD_TIMEOUT_MS` = 5s | 是，一次针对性的往返 |
| `onLifecycleChange(ref, from, to)` | 状态机推进之后，尽力而为的写回 | `SOURCE_TIMEOUT_MS` = 30s | 是 |

三个预算是三件不同的工作，不是同一个常量的三种调法：

- `enrich` 每次页面加载都跑，一个会拨号出去的来源会让首页慢得跟最慢的那个追踪器一样。300ms 是**故意**短到装不下一次真实 HTTP 往返的，逼着 enrich 去读缓存。
- `fields` 是按钮点击，但有人正盯着一个空输入框等它填上。复用 30 秒会让一个慢来源在模板选择器上坐满半分钟，所以它自己一个更短的数。
- `sync` / `refreshItem` 是显式动作，**预期**要真的发请求（Jira 是一次 dev-status 加每个 PR 一次 Bitbucket），预算要的是"慢但没卡死"那条线。

`enrich` 收到的单**只有 `source.provider` 跟自己相等的那些**。不认识的单不必出现在返回值里；返回值里出现没被问到的单 id，那一项会被丢掉。

### 失败语义：拿不到就当没有

没有一条是新的，全部沿用内核在这个接缝上一贯的姿态。一个来源坏掉，绝不能让首页画不出来。

| 发生了什么 | 结果 |
|---|---|
| `enrich` 抛 / 超时 / 返回的不是对象 | 这个来源这一轮没有 chip，首页照常渲染 |
| `fields` 抛 / 超时 / 返回的不是对象 | 这一轮没有字段，模板照常渲染，那几个占位符变空 |
| `sync` 抛 / 超时 | 零结果（`{created:0, updated:0, total:0, truncated:false}`） |
| `refreshItem` 抛 / 超时 / 没人认领这个 provider / 没实现 | 同一个 404。调用方不需要知道是哪一种 |
| `onLifecycleChange` 抛 / 超时 | 只记日志。已经落盘的状态迁移不撤销 |
| 两个来源撞 `provider` | 后者丢弃，记一行日志，不抛 |
| `role` 不是两个合法值之一 | 当没给，状态机看不到这条 facet |

分出更细的状态只会让页面替内核解释来源的毛病。

### 净化：内核不信任来源给的任何一个字段

`collectFacets` / `collectFields` 对来源的返回值逐字段过闸，来源自己不必（也不该指望能）绕过：

- `dim` / `value` / `label` 等文本一律截到 120 字符；`detail[].send` 宽一些，500 字符。
- `tone` 只认 `"ok"` / `"warn"` / `"dim"`，别的当没给。
- 任何 `url`（facet 的、明细行的 `url`、组的 `groupUrl`）只认 **http/https 的绝对地址**，走同一个 `safeHttpUrl`。`javascript:` 是实打实的注入面，相对地址则会按当前页解析而来源根本不知道自己被挂在哪个路径下——两种都不是"链接坏了"那么轻，所以是白名单，不是清洗。拿不准就丢掉，那一行还在，只是不可点。
- `icon` 只放行自闭合的几何图元标签，**元素名和属性名都是白名单**（`ICON_SHAPES`），属性值里不许出现尖括号或引号。
- `dim` 和 `fields()` 的键都不许以 **`item.`** 开头——那是内核自己的命名空间（`item.agent`、`item.sessions`、`item.source`、`item.tag`；字段侧是 `src/items/fields.ts` 的 `kernelFields`）。放进来等于让一个来源伪造这张单的 Agent 状态、标题或单号。
- 封顶：一张单合并**所有来源之后**最多 6 条 facet（`MAX_FACETS_PER_ITEM`），一个维度底下最多 20 行明细（`MAX_DETAIL_ROWS`），一张单最多 12 个字段（`MAX_FIELDS_PER_ITEM`），一个字段最长 4000 字符（`MAX_FIELD_LEN`）。facet 的封顶是在合并之后做的，不是每个来源一份配额——护的是卡片，两个来源合起来也不能把一张卡片挤爆。单张单的详情浮层不走这个上限（它不是卡片，没有那个空间限制）。

### 插件怎么把来源交出去

```ts
// plugins/handlers.ts
export type PluginServer = {
  handle?: PluginHandler;
  sources?: ItemSourceProvider[];
  enrich?: PluginEnricher;
  start?: () => void;
  readSettings?: () => Promise<Record<string, SettingValue>>;
  writeSettings?: (values: Record<string, string | boolean>) => Promise<void>;
  runAction?: (key: string) => Promise<boolean>;
};
```

`sources` 是零个或多个来源。`PluginServer.enrich` 是另一回事：**插件级**的 enrich 收到**全部**单，不按来源筛，留给那些不绑定任何来源、也想按自己的口径贴 chip 的插件（比如读 git 分支的）。绑定了来源的插件用来源级的 `enrich`，不用这个。两条路的预算和净化完全一样。

`TMUX_NEXT_DISABLE_PLUGINS` 对来源生效的唯一一处是 `sourceProviders()`（插件级 enrich 则是 `pluginEnrichers()`）。来源不经过 `/api/<id>` 那道 404 闸门——`refreshFromSource` 是直接调 `refreshItem` 的——所以这条过滤就是它唯一的闸门。

## 二、首页开给来源的扩展点，一张完整清单

| 位置 | 来源给什么 | 内核怎么画 |
|---|---|---|
| 单号前的徽标 | `badge: true` 的 facet，带 `icon` | 类型图标；title 列全部徽标维度 |
| chip 行 | `dim` / `value` / `tone` / `icon` | 一格文字，颜色按 tone；`dim` 是 i18n 键 |
| chip 可点 | `url` | 只认 http/https，新开标签 |
| chip 明细浮层 | `detail[]`：`label` / `value` / `tone` / `url` / `group` / `groupUrl` / `send` | 分组列表；有 `send` 的行画「发给会话」 |
| 卡片头的阶段灯 | `stage: {rank, total}` + `light` | 走过的绿、没到的灰、卡住的红 |
| 排序下拉 | `sortKey: {key, rank?}` | 同 key 聚成一个选项 |
| 分组 / 筛选 | 无需声明 | 从 chip 数据自动算 |
| 状态机信号 | `role: "pr" \| "check"` | 只看 `role`，不看 `dim` |
| 刷新按钮 | 来源认领了这个 provider（进得了 `claimedProviders()`） | 服务端在响应里告诉页面 `providers`；没实现 `refreshItem` 的来源按钮照画，点了就是那个 404 |
| 模板字段 | `fields()`，清单里 `fieldKeys` 列名 | 新建会话页的占位符 |
| 设置页 | 清单里 `settings` / `actions` | 表单和按钮 |
| 单号链接 | `source.url`，来源在 `ensureItemForSource` 时写 | 单号徽标可点 |

不在这张表里的东西没有：**没有**"单上的自定义动作按钮"，**没有**"自定义渲染块"。后者等于让来源往首页塞任意 HTML，撞的是"内核不解释插件内容"这条界线。等第二个来源真的需要时再论证。

### `dim` 是 i18n 键，不是显示文本

`jira.status`、`jira.epic` —— 来源的字典跟 `titleKey` 一样并进内核的两份字典，渲染时 `tr(dim)` 查得到就显示译文，查不到就退回显示 `dim` 本身。这一条是整个设计能不违反"内核绝不点名插件"的关键：**内核里因此没有任何"哪个来源有哪些维度"的表**——维度是数据，跟着 facet 一起来，分组和筛选都是从实际出现的 `dim`/`value` 组合里算出来的。

唯一要把维度名写成字面量的地方是清单的 `facetDims: [...]`，纯粹为了让 `src/i18n.test.ts` 的死键扫描有个字面量可找（`tr(facet.dim)` 是动态查找，扫描器看不见跟着数据来的键）。它对运行时渲染零影响。

### `role`：内核唯一"理解"来源内容的地方

```ts
role?: "pr" | "check";
```

单的进度状态机（`src/items/lifecycle.ts` 的 `deriveSignal`）要知道"这张单有没有 PR、检查过没过"，但它**不看 `dim`**——以前它按字面量找 `jira.prs` / `jira.checks`，那等于把状态机写死在一个来源的维度名上。现在它找的是 `role`：

- **`"pr"`**：`value` 是 PR 数，`detail` 每行一个 PR，**行的 `tone`** 是 `undefined` = open、`"dim"` = merged、`"warn"` = declined。`pr` 的 detail 里**只有带 `url` 的行算一个 PR**；没有 `url` 的行是注释（比如 Jira 的「另有 N 条 PR 未带本单号，已隐藏」），状态机不看——否则那行的 `tone: "dim"` 会被读成一个已合并的 PR。
- **`"check"`**：**顶层 `tone`** 是 `"ok"` = 全过、`"warn"` = 有失败。这条 facet **只在真的问到过检查时才出现**——缺席就是"没查到"，不是"过了"。两者是不同的事实，合并会让页面往"看起来整洁"的方向撒谎。

一张单上有多条同 `role` 的 facet（两个来源都贴了）时取第一条。这是今天的行为，写下来是为了不让它变成暗规则。

内核自己的 facet（`item.*` 维度）**不会有 `role`**：`role` 是来源说"我这条 chip 是 PR"的方式。这是一个封闭的两值枚举，故意封闭——它是内核对来源内容仅有的那一点理解，扩大它就是在把业务语义搬进内核。

### `url`：chip 本身指向哪里

跟 `FacetDetail.url` 走同一个 `safeHttpUrl` 白名单。两种画法：

- 有 `url`、**没有** `detail`：chip 画成 `<a target="_blank" rel="noopener">`。
- 有 `url`、**也有** `detail`：`detail` 优先——chip 仍是开浮层的按钮，链接放进浮层标题旁边（形状同 `groupUrl`）。

`facetChip` 的三个使用者（首页卡片的 `.facets` 行、表格视图的单元格、单浮层）都不在 `<a>` 里，嵌套合法。会话列表页卡片上的那颗单号 chip 是一个纯 `span`，不经 `facetChip`，不受影响。

### 来源侧的服务端文案没有 i18n 通路

`enrich` 在服务端跑，没有语言上下文——它不知道这次请求要中文还是英文。今天唯一受影响的是 Jira 的「另有 N 条 PR 未带本单号」那行明细，用的是中文字面量。这是一处记在案的妥协，不是设计；本轮不开这条通路。写新来源时知道这一点就好：能用 `dim`（i18n 键）表达的就别写死文案。

## 三、怎么接一个新来源：四步

1. **在 `plugins/<id>/` 下写一个 `ItemSourceProvider` 并导出。** 按 Jira 的形状，来源实现自己一个文件（`plugins/jira/source.ts`），缓存另一个（`cache.ts`），chip 拼装再一个（`facets.ts`）——`enrich` 只读 `cache.ts`，这样 300ms 的预算才守得住。

2. **在 `plugins/handlers.ts` 的 `SERVERS[id].sources` 里列出来。**

   ```ts
   SERVERS = {
     mytracker: { handle, start, readSettings, writeSettings, sources: [myTrackerSource] },
   };
   ```

   静态 import、字面量路径——运行时 `import()` 在这个仓库是禁止的（见 CLAUDE.md 的威胁模型），所以这张表只能手写。`plugins/registry.test.ts` 会检查清单和这张表两边同步。

3. **`sync()` 里用 `ensureItemForSource` 建单。**

   ```ts
   await ensureItemForSource(provider, ref, title, { refreshTitle: true, url });
   ```

   `provider` + `ref` 是这张单的身份：同一对值再来一次就是更新，不是新建。`refreshTitle: true` 让标题跟着来源走；`url` 就是上表最后一行的"单号链接"。`SyncResult` 如实报 `created` / `updated` / `total` / `truncated`。

4. **`enrich()` 只读缓存，一次请求都不发。** 300ms 不是可以商量的数字，它是这条扩展点存在的前提：首页的渲染速度不能是"最慢的那个追踪器"的函数。要新鲜数据就靠 `sync()` 和 `refreshItem()`——那是用户按下按钮才走的路，有 30 秒预算。

清单侧另外可选的几件事，都不是必须的：`titleKey`（设置页那一节的名字）、`settings` / `actions`（配置表单和按钮）、`facetDims`（给死键扫描看的维度名字面量）、`fieldKeys`（设置页列给模板作者的可用字段）。**`icon` 才是给插件一个 tab 的东西**——一个纯数据源不需要页面，也就不该有 `icon`；没有 `page` 也没有自带 `public/index.html` 的插件，`/p/<id>/` 会 301 到首页。

## 四、相关文件

| 文件 | 是什么 |
|---|---|
| `src/items/sources.ts` | 契约本身、三个预算、全部封顶与净化、`sourceProviders` / `claimedProviders` / `collectFacets` / `collectFields` / `runSync` / `refreshFromSource` / `notifyLifecycleChange` |
| `src/items/model.ts` | `WorkItem`；读用 `readItems` / `findBySource`，写用 `createItem` / `updateItem` / `ensureItemForSource`（没有一个叫 `writeItems` 的通用写入口——单的每一种写法都走各自的那个函数） |
| `src/items/lifecycle.ts` | 状态机，按 `role` 读信号 |
| `src/items/facets.ts` | 内核自己的 `item.*` 维度 |
| `src/items/fields.ts` | 内核自己的 `item.*` 模板字段 |
| `src/items/routes.ts` | `/api/items/*` 全部路由，响应里的 `providers` |
| `plugins/handlers.ts` | `SERVERS` 表、`PluginServer` 类型、设置与动作 |
| `plugins/types.ts` | `Plugin` 清单类型、`Facet` / `FacetDetail` / `ItemRef` |
| `plugins/jira/source.ts` | 今天唯一的实现，照着抄 |
