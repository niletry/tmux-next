# 手机友好的 tmux Web 客户端 — 设计

日期：2026-07-18

## 目标

在手机浏览器里查看和操作这台机器上**已存在的** tmux session，主要工作负载是运行在其中的 Claude Code。

核心场景：人不在电脑前，想知道某个 agent 跑完没有、它在问什么，并能回它一句话、按 Esc 中断、按 Shift+Tab 切模式。

## 背景与现状

**当前方案是 ttyd**：`ttyd -W -i 127.0.0.1 -p 7681 -t fontSize 14 ...`，由 Caddy（`example.internal:8443`）反代，Cloudflare DNS 签证书，basic_auth 加 cookie（因为浏览器不会在 WebSocket 握手时发 Basic Auth，靠 cookie 补上）。

ttyd 结构上给不了的东西，正是本项目要做的：

| | ttyd | 本项目 |
|---|---|---|
| session 列表 | 无，切 session 要在手机上敲 prefix 键 | 纯 web 列表页，带画面预览 |
| 分屏与 status bar | 原样显示 | 只渲染单个 pane |
| 宽度 | 跟随，无法锁定 | 锁 80 列，字号自适应 |
| 特殊键 | 无，靠软键盘 | 工具条 + Claude Code 预设 |

**webmux 不适用**（已核查 `~/projects/github/webmux` @ 0.42.0）：其数据模型是 `WorktreeInfo`，按 git branch 索引（`frontend/src/lib/types.ts:106-133`），`WorktreeSource` 只有 `"ui" | "oneshot"`（`backend/src/domain/model.ts:46`）。全项目仅两处调用 `tmux list-sessions`，均为清理与可用性检查，**不做 session 发现**。手工创建的 session 在它眼里不存在。

其中两处实现值得借鉴：`frontend/src/lib/Terminal.svelte:81-149` 的触摸滚动垫片（TUI 开启 mouse tracking 时把滑动合成为 wheel 事件），以及 `App.svelte:592` 的移动端 PaneBar。

## 已确定的设计决策

1. **一次一个 session，只渲染一个 pane**。不显示 tmux 的分屏与 status bar，切换靠界面而非 prefix 键。
2. **走 control mode**（`tmux -C attach`），不用 PTY + `tmux attach`。理由：`%output` 按 pane 分发，天然单 pane；window/session 事件结构化推送，列表页无需轮询；`refresh-client -A` 提供流控。代价见「风险」。
3. **每个连接一个 grouped session**（`web-<uuid>`）。作用是隔离「当前 window」并提供可销毁的 attach 点——**不是**隔离尺寸（见下）。
4. **锁 80 列**，字号由手机视口宽度反推，横屏字自然变大。
5. **工具条 + 手势并用**。工具条保证任何键都敲得出来，手势处理高频动作。
6. **应用不做鉴权**，只监听 loopback，沿用现有 Caddy 方案。
7. **Node + TypeScript**。control mode 走管道，不需要 node-pty。

## 关键实测结论

### tmux 无法把同一个 window 用两种尺寸渲染

原本假设 grouped session 能隔离尺寸，**实测证伪**：

```
tmux new-session -d -s sizetest -x 200 -y 50
tmux new-session -d -t sizetest -s sizetest-web -x 80 -y 24
→ 两者 window_id 均为 @48，尺寸均为 200x50（请求的 80x24 被忽略）

tmux set-option -t sizetest-web window-size manual
tmux resize-window -t sizetest-web:0 -x 80 -y 24
→ base 看到的 @48 也变成 80x24
```

尺寸是 window 对象的属性。不同 window 可以有不同尺寸（实测 @48 为 200x50、@50 为 74x46），但同一个 window 只有一个尺寸。

**采取的对策**：接受这个瞬时冲突。手机连上时该 window 变 80 列；若桌面同时在看同一个 window 会被压窄。缓解措施：

- 全局 `window-size` 保持 `latest`（本机现状），谁最近活动谁说了算，回到桌面一动即自动恢复。
- grouped session 上设 `aggressive-resize on`，手机与桌面看不同 window 时互不干扰。
- **因此第 4 步必须用 `refresh-client -C 80,<rows>` 而非 `resize-window` / `window-size manual`**——后者会钉死尺寸，破坏自愈。

实际影响有限：使用手机时人通常不在电脑前。

### 列表页预览的取法

`capture-pane` **只抓可见画面**（不加 `-S`）。加了 `-S` 会把陈旧的滚动历史抓进来——`orbit-spec` 曾被压到 2 列宽，历史里留下逐字换行的残骸，`-S -60` 抓出来是 `es`/`si`/`on` 这样的噪音。

取法：可见画面 → 滤掉空行、纯边框行（`─│╭╮╰╯━┃┏┓┗┛`）、Claude Code chrome（`bypass permissions`、`enter to collapse`、`new task? /clear`、独占一行的 `/rc`）→ 取最后 4 行。

实测 5 个 session 全部得到高区分度预览，例如：

```
perf          2 分钟前  ●
  要我把这份 EXPLAIN + A/B + VACUUM 发现发给 Ildar
  吗?这直接回答了他 "I need the full query to investigate"。
  ✻ Brewed for 3m 55s
```

两个附带结论：

- `❯` 开头那行是**你打了字还没回车**的内容，须单独标为「待发送」，不能与 agent 输出混排；为空则丢弃。
- `✻ Brewed for 3m 55s` 这类行的出现即表示 **agent 已停下在等你**。列表页据此给一个状态圆点——这是手机上最想知道的信息，且免费。

## 架构

```
手机浏览器 ──HTTPS/WSS──> Caddy ──> 应用(127.0.0.1) ──> tmux server
                                        │                (unix socket)
                                        └── 每连接 spawn 一个 `tmux -C attach`
```

### 后端模块

| 模块 | 职责 | 依赖 |
|---|---|---|
| `control-client` | 起 `tmux -C attach` 子进程；解析 `%begin`/`%end`/`%error` 输出块与 notification 交错的字节流，转为类型化事件。不含业务逻辑 | 仅子进程 stdio |
| `session-manager` | grouped session 生命周期：连接时创建，断开时销毁，定期清理孤儿 | tmux 命令 |
| `pane-stream` | 订阅目标 pane 的 `%output`，八进制反转义，合帧后推送；反向将按键写回 | control-client |
| `session-list` | 列表页数据：session 元信息 + 画面预览，靠 `%sessions-changed` 推送 | control-client、capture-pane |

`control-client` 是唯一有实质复杂度的模块（状态机：输出块与通知交错、命令编号对应、子进程异常退出）。**必须能脱离 tmux 单测**——喂录制好的字节流进去，否则后续每个 bug 都要手动复现。

### 前端

- **列表页**：普通 HTML/CSS，无终端。每行含 session 名、最后活动时间、状态圆点、4 行画面预览、待发送提示。
- **终端页**：xterm.js + WebGL addon + 工具条 + 手势层。
- 共用一个 WebSocket 连接管理器，负责重连与状态恢复。

## 数据流

### 连接时序

```
1. tmux new-session -d -t <目标> -s web-<uuid>
2. tmux set-option -t web-<uuid> aggressive-resize on
3. spawn: tmux -C attach -t web-<uuid>
4. refresh-client -C 80,<rows>
5. display-message -p '#{pane_id}'
6. capture-pane -p -e -J -t <pane>
7. display-message -p '#{cursor_x},#{cursor_y}'   (capture-pane 不带光标位置)
```

`rows` 由手机视口高度算出：先按「80 列须塞进屏宽」定字号，再用剩余高度算行数。转屏时重发第 4 步。

### 输出

`%output <pane-id> <八进制转义>` → 过滤目标 pane → 反转义 → **按 ~16ms 合帧** → 一次 `term.write()`。

合帧是必需的：Claude Code 刷屏时一帧内可能有数十条 `%output`，逐条写会阻塞主线程。

弱网时启用 `refresh-client -A`（pause-after），由 tmux 缓冲并通过 `%extended-output` 报告积压毫秒数；超过阈值则丢弃积压、重新 `capture-pane`，避免积压滚雪球。

### 输入

`send-keys -t <pane> -H <hex>`。用 hex 而非键名：工具条要发的 `Esc`(`1b`)、`Shift+Tab`(`1b 5b 5a`)、`Ctrl-C`(`03`) 用键名表达啰嗦且易错，hex 无歧义。连续按键在 ~10ms 内合并为一条命令。

### 重连恢复

手机锁屏、切换网络必然导致 WebSocket 断开，这是常态而非异常。

**设计选择：完全不做跨连接缓冲。** 每次连接（首次与重连一视同仁）都重跑一遍 `capture-pane` 重建画面。没有缓冲区、没有宽限期计时器、没有「该重放多少」的判断。状态本就活在 tmux 里，在应用层复制一份是多余的，且是一整类 bug 的来源。

capture 与实时流的分界，利用 control mode 的串行性：man page 明确 "A notification will never occur inside an output block"，因此 `capture-pane` 的 `%begin`/`%end` 是流中的栅栏——`%begin` 之前的 `%output` 已体现在 capture 内容里，丢弃；`%end` 之后的才应用。

**已知边界**：`%begin` 与 `%end` 之间产生的输出会被 tmux 推迟到 `%end` 之后发出，可能与 capture 内容重叠，造成几个字节重复。窗口期微秒级，接受；若实测被咬到，再加基于 `#{history_size}` 的校验。

### 孤儿清理

grouped session 统一命名 `web-<uuid>`。断开连接时主动 kill；同时在后端启动时及每分钟扫描，清理所有无 client 连接的 `web-*` session——不能只依赖主动清理，因为进程被 `kill -9` 时不会执行。

## 移动端交互

- **工具条**：`Esc`、`Tab`、`Ctrl`（粘滞键）、`Shift+Tab`、方向键。针对 Claude Code 的预设：Esc 中断、Shift+Tab 切模式、Ctrl+R 展开。
- **手势**：上下滑动翻 scrollback。当 TUI 开启 mouse tracking 时让位给应用——借鉴 webmux `Terminal.svelte:81-149` 的合成 wheel 事件方案。
- **软键盘**：用隐藏 `<input>` 触发软键盘并捕获输入。iOS Safari 弹出键盘会顶高 viewport，须用 `visualViewport` API 计算终端高度（webmux 没做这块，无可借鉴）。

## 风险

**唯一的真风险：control mode 的吞吐。** `%output` 将非打印字符转义为八进制（`\033` 一字节变四字节），TUI 输出几乎全是控制字符，数据量预计涨 2-3 倍，另加一层解析开销。Claude Code 刷屏频繁。

**缓解**：正式开工前先做吞吐 spike——在 tmux 里跑 Claude Code，用 control mode 接出来测刷屏时的延迟与 CPU。数据不可接受则退回 PTY + `tmux attach`（代价：放弃单 pane 渲染，分屏会显示出来）。前端不受影响。

## 验证计划

1. **吞吐**：control mode 接 Claude Code，测刷屏延迟与 CPU。（本机可验）
2. **重连**：断线后画面能否干净恢复，是否花屏。（本机可验）
3. **80 列可读性**：在真机上看字号是否可接受。（需要手机）

## 非目标

- git worktree / PR / CI 集成（webmux 的领域）
- 多 pane 同时显示、拖拽分割线
- 在 web 端创建复杂 tmux 布局
- 应用层鉴权（由 Caddy 承担）
