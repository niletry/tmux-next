# 单子驱动：内核长出 Work Item，会话退为它的手段

## 问题

这个应用现在的轴心是**会话**。首页是一列 tmux 会话，按目录分组、按活动时间排序；工单是插件里的一个 tab，它在自己那一页上已经做出了"单为组、会话挂在组下"的形态，但那只是一页的形态，不是应用的形态。

结果是同一件事在两个地方各讲一半：会话列表知道"这条在跑什么"，工单页知道"这条是为了什么"。要把两者对上，得来回切页。

工作是按单来的。轴心应该翻过来：**首页列单，会话是单底下的手段。**

## 已定的取舍

五条在设计对话里定死，不再重开：

- **「单」是内核概念，Jira 只是来源之一。** 不能把 `/p/jira/` 提成落地页——那要内核点名一个插件，直接撞上"内核绝不点名插件"的界线，且关掉 Jira 插件应用就没首页了。
- **开会话前先选/建一张单。** 新建流程的第一屏从"选目录"变成"选单"。
- **不按来源区分会话。** 外部 `tmux new` 起的会话与本应用起的一视同仁——tmux 在这里只是进程管理器。它们不会被藏起来，也不会被自动造一张假单装进去。
- **状态、Epic 这类东西是维度标签（facet），不是排序规则。** 模型只负责如实提供维度，怎么分组、怎么排是视图层的事，可以慢慢优化（group-by、面板）。
- **内核存一张自己的单，上面挂一个外部引用。** 远端的标题/状态/Epic 是**叠上去的**，拉不到就少几个维度，单本身照常在。

## 数据模型

两个内核叶子模块，纯文本、可 `cat`、坏了直接删——跟 `pins.json`、`notifications.jsonl`、`theme.json` 同一套。

**不上 `bun:sqlite`。** 理由沿用 Jira 插件那份 spec：数据量由"你有多少个 tmux 会话"封顶，永远是几十条；仓库里每一处状态都是纯文本，引入二进制格式会破坏这个一致性并多出迁移问题。

### `src/items.ts` → `~/.tmux-next/items.json`（`TMUX_NEXT_ITEMS_PATH`）

```ts
export type WorkItem = {
  id: string;                 // 内核生成，稳定，永不变，URL 里用它
  title: string;              // 本地标题，可改
  cwd: string | null;         // 这张单默认在哪开会话
  source: { provider: string; ref: string; url?: string } | null;
  tags: string[];             // 本地自由标签
  createdAt: number;
  closedAt: number | null;    // 归档，不是删除
};
```

`id` 由内核生成（`it-<base36 时间><4 位随机>`），不复用单号：单号可以改、可以在认领之后才补上，而 URL 与绑定必须指得住。

`source.provider` 是个字符串，**不是插件 id 的别名**。内核不校验它对应某个已注册插件——一张来自已停用插件的单仍然是一张单，只是没人给它叠维度。

### `src/session-binding.ts` → `~/.tmux-next/bindings.json`（`TMUX_NEXT_BINDINGS_PATH`）

```ts
{ "<会话名>": { itemId: string; sessionId: string; boundAt: number } }
```

**按会话作键。** 这条直接继承 `plugins/jira/bindings.ts` 的原始论证，它没有因为搬进内核而失效：一张单多个会话是常态（会话名唯一，单不唯一），反过来存（单 → 会话数组）则每次会话改名或消亡都要去数组里翻。

**`sessionId` 与会话名双写。** `#{session_id}` 跨改名不变、跨 tmux server 重启会重排；名字反过来。先按 id 认、认不上按名字认，两者各覆盖一半，于是**内核仍然不需要长出一个"会话改名事件"**。

会话 id 从哪来：现在是内核自己的事了，`src/tmux/session-list.ts` 的格式串里加 `#{session_id}`。当初那条"不要为一个插件的需要往内核列表里加字段"的禁令在这里不适用——绑定已经是内核概念，加的是内核自己要用的字段。`plugins/jira/sessions.ts` 里那次单独的 `list-sessions` 随之退休。

### facet 一个都不存

状态、Epic、PR 数、检查红绿、Agent 在跑还是在等你——全部每次请求现算。

存下来就要同步，而"内核存自己的单 + 外部引用"这个模型之所以成立，正是因为远端那部分是叠上去的。离线或 Jira 挂掉时，那几个维度**消失**而不是显示上次的值：一个过期的状态比没有状态更坏，它看起来是真的。

只有 `tags` 是本地的，因而是存的。

### 归档不是删除

`closedAt` 让单从默认视图消失，但它的绑定记录还在。手机上误点一下不该丢掉一个跑了两天的会话的归属；单被归档后它的会话仍然活着，只是从首页默认视图里收起来。

### 写入

`plugins/jira/bindings.ts` 里那条序列化写队列 + 临时文件 `rename` 的组合提升成 `src/json-store.ts`，两个新模块共用。**是搬家，不是新增。**

两件事它各管一半，缺一不可：`rename` 在同一文件系统内原子，防的是另一个 `bun` 进程读到写了一半的 JSON；序列化队列防的是本进程内并发的读-改-写互相丢更新。队列只在本进程内有效，两个 `bun` 进程同时写同一份文件不在它的保护范围内——这一点不作任何相反的宣称。

## 插件接缝：`annotate` → `enrich`

现有的 `PluginAnnotator: (sessions: string[]) => Record<string, Annotation>` 泛化为：

```ts
export type Facet = { dim: string; value: string; tone?: "ok" | "warn" | "dim" };
export type ItemRef = { id: string; source: { provider: string; ref: string } | null };
export type PluginEnricher = (items: ItemRef[]) => Promise<Record<string /* item id */, Facet[]>>;
```

`collectAnnotations` → `collectFacets`。**安全阀一字不改**，因为开这个口子的前提就是它：

- 300ms 硬超时，`try/catch` 包住
- 失败语义唯一：**拿不到就当没有**，首页照常渲染
- `value` 截断 120 字符
- 丢掉没被问到的 item id
- 新增一条：**每单最多 6 个 facet**，一个插件不能刷爆卡片

`ANNOTATORS` 表继续从 `SERVERS` 推导，`collectFacets` 继续把 annotator 表**作为参数**接收——注册表是编译期常量，没有这个参数就没法塞进"会抛的假插件"和"永远卡住的假插件"，那两条测试是这个口子可以被接受的唯一证据。

### `dim` 是 i18n 键，不是显示文本

`jira.status`、`jira.epic`。插件字典本来就合并进内核字典，所以 `tr(dim)` 直接查得到，查不到就退回显示 `dim` 本身。

**内核里因此没有任何"哪个插件有哪些维度"的表。** 维度是数据，跟着 facet 一起来。这条是这个设计能不违反插件界线的关键。

### 内核自己也产 facet，走同一条路

`item.agent`（等你回答 / 在跑 / 停了，从会话摘要的 `turn` 与 `idle` 推）、`item.sessions`（几个会话）、`item.cwd`、`item.tag`（每个本地标签一个）、`item.source`（来源名）。

于是视图层的 group-by 不需要知道一个维度是内核的还是插件的——这正是"视图后边可以慢慢优化"能成立的前提。

### 不按 `source.provider === 插件 id` 预筛

传全部单给每个声明了 `enrich` 的插件，让它自己看 `item.source` 挑。

预筛会在内核里写死"provider 名就是插件 id"这个等式，而那正是要守的那条线。成本可以忽略（几十条），还顺带允许一个不绑定任何来源的插件（比如读 git 分支的）也贡献维度。

### Jira 插件净减

- `plugins/jira/bindings.ts` 整个删掉，内核接管
- `plugins/jira/sessions.ts` 删掉（它只为拿 `#{session_id}` 而存在）
- `annotate` 从"会话 → 单号文本"改成 `enrich`：单 → 状态 / Epic / PR 数 / 检查红绿四个 facet
- 它仍然**不在 enrich 里访问 Jira**：这条路每次页面加载都跑、预算 300ms，网络往返进不来。继续读已有的 60 秒缓存，缓存未命中就少给几个 facet

## 首页与视图

### 导航

`/` 从会话列表变成**单列表**。会话列表不消失——它退成一个 tab（`sessions.html`），因为"这台机器上现在有哪些 tmux 会话"仍然是个正当问题，而且外部起的会话要有地方看。

导航变成：**单（首页） · 会话 · 制品 · 通知 · 工单**。

Jira 的 tab 保留（判断点 A，见下）。它的职责变了：从"我的工单"变成**"Jira 那边有什么"**——列出 JQL 查到的工单，每条一个「认领为单」，加上配置说明。它那 1025 行的富 UI（PR 行、检查浮层、提问弹窗、Markdown 渲染）原地不动，单卡片点进去仍落到 `/p/jira/?key=…`。

### 单卡片

标题（可点进单详情）· 来源徽标（可点开 Jira）· facet chips · 底下每个会话一小行（状态、最后动作、进入）· 「再开一个会话」。

facet chip 的 `tone` 决定颜色，颜色只能来自主题变量——`src/themes.test.ts` 会拦住任何新的颜色字面量。

### 视图控件

一个 group-by 选择器 + facet 筛选。**选项从当前数据里出现过的 facet 现算**，沿用工单页 `filter.js` 已经在用的做法，而不是维护一张写死的维度表。

默认 group-by = `item.agent`（判断点 B）。视图选择存 `localStorage`（判断点 C）。

### 未归单

首页底部一个固定分组「未归单」，收所有没有绑定的会话，每条一个「归到…」。

这是"不按来源区分会话"那条取舍的落点：它们不变成单、不消失，就是一个明确的**待归类**区，而不是第二套平行模型。

## 新建流程

`＋` → `new.html`，第一屏从"选目录"变成**"选单"**：

1. 列出未归档的单（可搜），外加「新建一张单」
2. 建单 = 标题 + 目录 + 可选「关联工单」（从 Jira 候选里挑，或直接粘一个单号）
3. 选定单之后，目录默认取该单的 `cwd`；没有就落回现有的目录浏览屏
4. 会话名可以留空——**单号不再需要被塞进会话名**，那是这次改造顺带还掉的一笔债

从单卡片的「再开一个会话」进入时跳过第一屏，单已经定了。

## 迁移

一次性、幂等，在首次读 items 时执行：

若 `items.json` 不存在**且** `~/.tmux-next/jira/bindings.json` 存在 → 每个不同的单号建一张单（`title` 先用单号本身，`source = { provider: "jira", ref: 单号 }`），并把会话绑定搬进内核的 `bindings.json`。

- 写出 `items.json` 即视为完成，之后不再检查
- **不删旧文件**，留一版回退证据
- 没有绑定的会话不造单，它们落进「未归单」

## 分期

三期，每期都能单独跑起来、单独提交：

1. **内核 store + 迁移 + `/api/items`。** 首页仍是会话列表，但每行显示所属单（数据源从插件 annotate 换成内核绑定）。
2. **`enrich` 接缝替换 `annotate`**，Jira 插件改造；首页换成单列表 + 视图控件；会话列表退为 tab。
3. **新建流程改为先选单**；「未归单」的「归到…」；Jira tab 改成候选单页。

## 测试

沿用仓库既有的分层：纯逻辑无头测，会渲染的浏览器模块必须有渲染测试，真跑 tmux 的走集成。

- `src/items.test.ts` / `src/session-binding.test.ts`：CRUD、归档、按 id 优先按名兜底的解析、坏 JSON 读成空表。路径走 env 覆盖，绝不碰用户的 `~/.tmux-next/`
- `src/json-store.test.ts`：并发写不丢更新（现有 `bindings.test.ts` 的那条搬过来）
- `src/plugin-enrich.test.ts`：继承会抛 / 会卡住的假插件两条，新增每单 facet 上限、未知 id 丢弃、`value` 截断
- `src/items-page.test.ts`：happy-dom 挂载首页，断言 DOM。**这条不可省**——`public-parses.test.ts` 只证明文件能解析、import 能解析，不证明它画得出东西；这个缺口已经放过两个 bug（`tr` 没 import、`history.replaceState` 抛异常吞掉半个页面）。DOM shim 必须还原它替换掉的全局对象
- `src/migrate-jira-bindings.test.ts`：迁移一次、再跑一次不重复建单；旧文件不存在时静默跳过
- `src/binding.integration.test.ts`：真 tmux——建会话、绑定、改名后仍解析得中、kill 后标记为不在。清理只按 `=<确切名字>` 杀自己这轮建的会话
- i18n：`src/i18n.test.ts` 自动覆盖新键（缺一边语言就红）
- 主题：`src/themes.test.ts` 自动覆盖新样式里的颜色字面量

## 判断点（等确认）

设计对话里没问到，我按下面这样定了，需要复核：

**A. Jira 的 tab 保留，职责改为"Jira 那边有什么 + 配置"。** 备选是给清单加一个 `nav: false` 把它从导航里摘掉，只留详情页。没选它，是因为原 spec 有一条明确论证：未配置时 tab 仍然显示，因为**那是你唯一能发现这功能存在的地方**，藏了就没人配得起来。

**B. 默认 group-by = `item.agent`。** 你说了视图后边慢慢优化，但总得有个默认；选它是因为手机上第一眼要回答的是"该我动了吗"。改成按 Epic 或按工单状态只是换个默认常量。

**C. 视图选择（group-by + 筛选）存 `localStorage`，逐设备。** 跟字号同类——"这块屏怎么看"是设备的事；而主题存机器（`~/.tmux-next/theme.json`），因为"这台机器长什么样"是机器的事。若你认为视图应该跨设备一致，就得给它加一个服务端状态文件。

## 不做

- **不做任何回写。** 不改 Jira 状态、不写评论、不记工时。写操作发生在一个无认证的服务里，风险面完全不同，要做也是另一份 spec。
- **不做第二个 provider 的候选接缝**（`listCandidates`）。现在只有 Jira 一家，认领入口就在它自己的页上。真接第二家时再补，那时形状也更清楚。
- **不做插件贡献富详情区**（PR 列表、检查明细进内核卡片）。能力面按需要开，不按能想到的开——现在跨页一跳是可以接受的代价。
- **不改会话终端页。**
