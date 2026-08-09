# 同类方案的架构对比

2026-08-09 的一次调研。记录几个"从手机操作本机 AI 编码 agent"的方案各自
怎么解决同一组问题，供以后做取舍时对照。只写查证到的机制，不评价优劣——
每种选择都有它成立的场景。

## 三个必须分开看的问题

这几个方案看起来在做同一件事，但它们各自解决的是不同的子问题。混在一起
看就会觉得"都差不多"：

| | 问题 | |
|---|---|---|
| **连通性** | 手机的包怎么到达那台机器 | NAT 后面的机器不能直接连 |
| **认证** | 到达之后凭什么放进来 | |
| **抓取** | 拿到的是终端字符，还是 agent 的结构化事件 | 决定界面能做到什么 |

## 各方案

### Claude Code 官方 Remote Control

2026-02 起的 research preview。`/config` 里开启，本地会话出现在 claude.ai/code
和官方手机 App 里，会话仍在本机运行。

- **连通性**：Anthropic 的服务器中转，用户无需配置
- **认证**：两端同一个 Anthropic 账号
- **抓取**：Claude 自己的会话协议
- 只支持 Claude；跑不了 Claude 界面之外的终端命令；可见性与账号档位有关

### Orca（`stablyai/orca`，MIT）

主张不是"手机看 agent"，而是**同一个 prompt 分发给多个 agent 并行**：每个
agent 独占一个真实的 git worktree，自带终端、Chromium tab、Monaco 编辑器和
独立上下文，跑完对比结果、合并赢家。文件系统级隔离，agent 之间不共享状态。

手机端是这套东西的监控窗口，不是产品核心。

- **连通性**：**不提供**。默认同一局域网直连（`ws://192.168.0.179:6768`），
  跨网络要用户自己做端口转发或 Tailscale
- **认证**：扫二维码配对，码里含 endpoint + 设备 token + TLS 指纹；每设备
  一份凭据，升级后无需重新配对
- **抓取**：终端（支持任意 CLI agent，列了 30+ 家）

`orca serve` 可以把整个运行时跑在服务器上，客户端通过 LAN / Tailscale /
SSH 端口转发 / 隧道接入。它把监听地址和对外地址拆成两个字段
（`boundEndpoint` / `advertisedEndpoint`），所以服务在 NAT 后面监听
`0.0.0.0` 而告诉客户端连 `https://orca.example.com/runtime`，不必改服务端
配置。

### MobileVibe（`mobilevibe.com`，闭源）

- **连通性**：自家云中转，因此在任何网络下都能连
- **认证**：Apple / Google 账号
- **抓取**：agent 的协议流。文档要求"必须通过它启动编辑器"——因为要控制
  启动参数，把 agent 拉进程序化模式并接管其 I/O

官网称 "All execution happens locally. Nothing in the cloud." 与
"End-to-end encrypted"。前者说的是代码在哪执行；流量如何路由（P2P 打洞还是
经其服务器转发）文档未说明。

注意有个同名但架构相反的 `mobilevibe.io`，是纯 iOS 上的编码环境，找资料时
容易混。

### webtmux（`chrismccord/webtmux`）

Go 单二进制 + xterm.js，扩展 gotty 协议加了 tmux 专用消息类型：侧边栏
minimap、窗口标签、触屏分屏按钮、上滚自动进 copy-mode。未使用 tmux 控制模式。
无会话列表、无重连处理、无通知。

### Tailscale + mosh + Blink/Termux

组件各自开源。P2P 加密网状网，mosh 处理网络切换后的重连。抓的是完整终端。
设置最复杂，但链路最透明。

## tmux-next 在这张表里的位置

- **连通性**：不提供，由用户用反代或 Tailscale 解决（同 Orca）
- **认证**：反代的 Basic Auth + 一个所有设备共用的 cookie
- **抓取**：tmux **控制模式**——`%output` 按 pane 分发，因此能只渲染一个
  pane、不带 tmux 状态栏和分割线

与上述几家的结构性差异在于**它不启动 agent，而是接管已经存在的 tmux 会话**：
SSH 上去手开的、别人开的、非 agent 的构建任务，都在列表里。agent 的生命周期
挂在 tmux server 上，与浏览器和网络无关。

代价是界面只能是 agent 自己画的 TUI——做不了"逐条批准某个工具调用"这类需要
结构化事件才能实现的交互。

## 两个可借鉴的具体机制

**`advertisedEndpoint` 与监听地址分离。** tmux-next 目前隐含假设"用户访问的
地址 = 服务绑定的地址"，在反代后面这个假设不总成立，会影响生成的链接与推送
通知的跳转目标。

**每设备一份认证凭据。** 现在是所有设备共用一个 cookie，无法单独吊销；设备
丢失只能更换凭据、导致全部设备重新登录。Orca 的做法是配对时下发设备 token，
可按设备吊销。
