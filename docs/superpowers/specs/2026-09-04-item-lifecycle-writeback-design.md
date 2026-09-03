# 从「读」到「写」：单的进度状态、写回 Jira、和一条通知总线

## 问题

工单（"单"）现在是内核概念，Jira 同步、会话绑定、facet 展示都齐了——但整条链路只有一个方向。`plugins/jira/dev.ts` 对 Jira/Bitbucket 全是 GET，没有一处改外部状态；`items.ts` 里"这张单现在到哪一步了"这件事，只能靠人自己拼"绑了几个会话"和"最近的 PR 列表"两个側面信号；PR 检查转绿、被合并这些事，除了下次手动刷新页面，没有任何通道会主动告诉你。

调研了一圈同类产品（Devin/Copilot coding agent/Cursor/Codegen/Tembo 等九款自主 agent，Claude Remote Control/Orca/Warp 等五款会话接管型，CodeRabbit/Graphite/Mergify 等五款 PR 收尾型）之后，两个判断定了这次的方向：

- **"合并后工单自动流转状态"这件事，没有一家收尾类产品真正做到**，但 Jira/GitHub/Bitbucket 原生免费接口就能做——不需要造审查引擎或合并队列，只需要照着 Jira 的 transitions API 打一发调用。
- tmux-next 现有架构唯一天生比所有竞品强的维度是"人随时能接手"，这次要接的三块东西都不能反过来把这条路堵上：状态机是给人看进度用的，不是用来自动化掉人的判断。

这次把"读的一半"接上"写的一半"里成本最低、跟其他子系统耦合最少的三块：**单的进度状态机**、**往 Jira/PR 写回**、**状态变化推送通知**。触发器（webhook 自动建会话）明确不在这轮范围内，留给下一轮单独设计。

## 已定的取舍

- **状态机是内核概念，Jira 自己的 workflow 状态不受它管辖**——两者是两件事：Jira 的 status 是 `jira.status` facet，继续只读展示;新加的 `WorkItem.status` 是 tmux-next 自己的六档进度,只在**目标是让 Jira 也看到**时才单向写过去,绝不反过来读 Jira 状态回填自己的 status。
- **状态从已有信号推导，不接受外部直接写入。** 没有 `PATCH /api/items/:id/status` 这种接口——状态永远是 `sync`/`refresh` 跑完之后，从当前 facet（绑定、PR、checks）现算出来的结果,人改不了。这是延续"facet 是每次现算、不落盘"的既有规则做的一个例外——**这次要落盘**，理由在下面单独一节说。
- **`in_review → in_merge` 是近似值，不是真实的"可合并"。** 上一轮竞品调研已经确认，Bitbucket 公开 API 拿不到真实的审批/合并冲突状态；这条迁移用"PR 还开着 + 所有 CI 检查转绿"代表"接近可合并"，状态名保留"待合并"但心里清楚这是个近似——`checksKnown` 为假时（没查到，不等于没有）不触发这条迁移，宁可停在待审查也不要给一个假的"待合并"。
- **写回失败不回滚本地状态。** 状态机已经落盘的迁移不因为 Jira/Bitbucket 那头网络抖动而撤销,只记日志——跟 `collectFacets`/`refreshFromSource` 现有的"一个插件挂了不拖累别的"是同一条原则的另一种写法。
- **归档沿用现有机制，这次不新建。** 写这份 spec 之前的判断是"`items.ts` 没有 archive"——重新读代码发现是错的：`WorkItem.closedAt` 从第一个提交（`cad19f6`）就在，`items.js` 里已经有归档/取消归档的按钮。这次唯一要做的是把"到了 `done` 状态"和"要不要归档"解耦——**到 `done` 不自动归档**，归档仍然是人按一下的动作，`status` 和 `closedAt` 是两根独立的轴,不是一根轴的两端。

## ItemLifecycle 状态机

### 状态与迁移

```ts
// src/item-lifecycle.ts
export type ItemStatus = "unclaimed" | "in_progress" | "in_review" | "in_merge" | "done";
```

五档，不是六档——上面那条"取舍"已经把"已归档"从这个枚举里去掉了：归档是 `closedAt`，不是 `status` 的第六个值。

| 迁移 | 信号 |
|---|---|
| `unclaimed → in_progress` | 出现至少一条**活着**的绑定会话（复用 `session-binding.ts` 的 `live` 判定,跟 `item-facets.ts` 的 `item.agent` 用的是同一份绑定数据） |
| `in_progress → in_review` | `jira.prs` facet 非空 |
| `in_review → in_merge` | PR 仍是"开着"状态 **且** `checksKnown === true` **且**所有 check 的 tone 都是 `"ok"` |
| `in_merge → done` | dev-status 里对应 PR 的状态变成 `MERGED` |

状态机只前进,不后退——比如一个已经 `in_review` 的单,PR 被关掉但没合并,状态停在 `in_review` 不回退到 `in_progress`,因为"这张单曾经有人认领并开出过 PR"是一个不该被抹掉的事实,回退等于说谎。唯一的例外是 `unclaimed`:所有绑定都失效(会话被杀、绑定记录清空)且从未进入过 `in_review` 时才允许回到 `unclaimed`——`in_review` 及之后不可逆,理由同上。

### 信号收集与推导：两个纯函数

```ts
// src/item-lifecycle.ts

/** 从已经算好的 facet + 绑定信息里挤出状态机要看的四个信号，不碰 I/O。 */
export type LifecycleSignal = {
  hasLiveBinding: boolean;
  hasOpenPr: boolean;
  prMerged: boolean;
  checksAllOk: boolean; // checksKnown 为假时这里也是 false——"没查到"不等于"过了"
};

export function deriveSignal(facets: Facet[], hasLiveBinding: boolean): LifecycleSignal { ... }

/** 状态机核心。纯函数,不落盘、不发请求——喂 (当前状态, 信号) 吐出下一个状态。 */
export function nextStatus(current: ItemStatus, signal: LifecycleSignal): ItemStatus { ... }
```

`deriveSignal` 读的是 `jira.prs`/`jira.checks` 这两个 facet 的 `detail` 明细（`FacetDetail.tone`），不是插件私有数据结构——这条边界不能破,内核不能因为写状态机就开始认识 Jira 的 PR 对象长什么样。`nextStatus` 是一张纯粹的表驱动函数，五档之间总共只有四条迁移边，直接列 `switch` 就够，不需要真状态机库。

两者都无 I/O，测试直接喂 `Facet[]` 断言下一个状态，不需要起真会话或真 Jira——这跟仓库里 `template.ts`/`geometry.ts` 的测法是同一路数。

### 落盘位置

`WorkItem` 加一个字段：

```ts
// src/items.ts
export type WorkItem = {
  // ...现有字段不变
  status: ItemStatus; // 新增，默认 "unclaimed"
};
```

沿用 `readItems`/`writeItem` 现有的"坏文件读成默认值、绝不抛"规则，`sanitiseSource` 旁边加一个同类的 `sanitiseStatus`。旧文件没有这个字段的单读出来一律是 `"unclaimed"`，下一次 `sync`/`refresh` 跑到它时会立刻推一次真实值——不需要迁移脚本。

### 调用点

不新开轮询。`runSync()`/`refreshFromSource()`（`plugins/handlers.ts`）跑完、`collectFacets` 给出这一批单的 facet 之后，调一次：

```ts
// src/item-lifecycle.ts
export async function advanceLifecycle(
  items: WorkItem[],
  facetsByItem: Record<string, Facet[]>,
  bindings: ResolvedBinding[],
): Promise<{ item: WorkItem; from: ItemStatus; to: ItemStatus }[]>
```

返回"这一轮真正发生了迁移的单"列表——空数组是最常见的返回值（大多数单这一轮什么都没变），写回层和通知总线都只对这个列表里的条目动作，不用重新判断"变没变"。

## 写回层

### 走 `provides` 分派，不是内核认识 Jira

```ts
// plugins/types.ts，Plugin 类型新增两个可选导出
export type PluginWriteback = {
  /** 把 ItemLifecycle 的状态迁移映射成这个来源自己的写操作。失败只记日志，不抛。 */
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};
```

不单独开 `writeStatus`/`commentOnPr` 两个接口——插件内部要不要评论、要不要转状态、转成 Jira 的哪个 workflow 状态，都是 Jira 插件自己的判断，内核只知道"迁移发生了，通知认领这个 provider 的插件一声"，跟 `refreshFromSource` 的分派方式完全同源：

```ts
// plugins/handlers.ts，跟 refreshFromSource 并列的新函数
export async function notifyLifecycleChange(
  provider: string,
  ref: string,
  from: ItemStatus,
  to: ItemStatus,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<void> {
  const plugin = SERVERS.find((p) => p.provides?.includes(provider) && isConsidered(p.id, enabled));
  await plugin?.onLifecycleChange?.(ref, from, to).catch(() => {});
}
```

30 秒预算复用 `SOURCE_TIMEOUT_MS`——这是"人按了一下按钮、真实网络请求"的量级（`sync`/`refreshItem` 那一档），不是 `enrich` 的 300ms。

### Jira 插件里的实现

`plugins/jira/server.ts` 新增 `onLifecycleChange`，内部两件事：

1. **状态迁移到 Jira 的 workflow 状态**——查一张"内核状态 → Jira 状态名"的映射表，走 Jira REST 的 `/issue/{key}/transitions` API（不是 Smart Commits：Smart Commits 靠解析提交信息里的魔法字符串,是给人手打命令用的,这里是程序化调用,直接打接口更可靠、不依赖提交信息格式）。映射表进插件的 `settings`,五个内核状态各对应一个可填的 Jira 状态名,留空表示"这一步不写回"——不是每个 Jira workflow 都有五个刚好对应的状态,留空的自由必须给使用者,不能内核帮它猜。
2. **进入 `in_review` 时评论一句**——只在这一步评论,不是每次迁移都评论：从"没人看"变成"有 PR 可以看"是唯一一个"外部人类需要被叫过来看一眼"的时刻,`in_merge`/`done` 这类内部记账式的迁移没有必要打扰 PR 评论区。评论走 Bitbucket 现有的 `dev.ts` 里已经在用的鉴权（`bitbucket.email`/`bitbucket.appPassword`），加一个 POST 到 PR comments 端点。

失败处理：两步各自 try/catch，一步失败不影响另一步，都失败也不影响状态机本身——`advanceLifecycle` 已经把新状态落了盘,写回层是纯粹的"尽力而为的旁路"。

## 通知总线

### 复用 `push.ts`，不是新开一条通道

`notify()` 现有签名是围绕**会话**设计的（`session` 作标题、`PushEvent` 只有三档、i18n key 是 `push.waiting`/`push.ended`/`push.attention`）——单的迁移事件标题是单标题不是会话名，硬塞进 `notify()` 的签名会让"session 参数到底装的是会话名还是单标题"变成一个要看调用点才知道的事。开一个并列的函数，内部结构照抄 `notify()`（`readSubscriptions`/`getVapid`/`sendPush`/`recordNotification` 全部复用），只有事件文本和去重键不同：

```ts
// src/push.ts
export async function notifyLifecycle(
  itemId: string,
  itemTitle: string,
  to: ItemStatus,
  opts: { nowMs?: number; send?: Fetch } = {},
): Promise<NotifyResult>
```

### 去重

不复用 `allowNotify` 的 30 秒滑动窗口——那是给"同一个会话短时间内连续吵"设计的节流,迁移事件天然只发生一次(状态机只前进,`advanceLifecycle` 已经保证一轮里同一张单最多返回一条迁移记录),不需要时间窗口,去重键就是 `${itemId}:${to}`,发过就不会再发第二次(存在跟 `lastNotify` 同结构的 `Set<string>`,不需要记时间戳)。

### 文案

五个迁移各一条 i18n 模板（`push.item.in_progress`/`push.item.in_review`/`push.item.in_merge`/`push.item.done`,`unclaimed` 是初始状态不触发迁移通知),标题是单标题,正文只讲"进入了哪个状态",不引用任何 Jira/Bitbucket 专有字段——通知内容和 `Facet`/`PluginFieldSource` 遵守的是同一条边界:内核层的文案不认识插件语义。

## 不在这轮范围内

- **触发器/自动化**（事件自动建会话、自动起 agent）——下一轮单独设计,这轮的状态机、写回、通知都不依赖它先做完。
- **`done` 之后自动归档 / 自动清扫**——归档继续是人按一下的动作;`status` 到 `done` 只是让人知道"这张单干完了",不替他做归档决定。
- **真实的 PR 审批/合并冲突状态**——`in_merge` 这一档从设计上就是近似值,不追求解决这个问题(上一轮调研已经确认公开 API 拿不到,解决需要存一份完整浏览器会话,成本和风险跟"多问 CI 检查一嘴"不是一个量级)。
