# tmux-next

手机友好的 tmux web 客户端。查看和操作本机已存在的 tmux session，主要用于隔空盯着跑在里面的 Claude Code。

- **列表页** — 所有 session，带最后画面预览、「在等你」状态点、未发送的输入
- **终端页** — 单个 pane 全屏，锁 80 列，键盘工具条（Esc / ⇧Tab / Ctrl / 方向键）
- **断线自动重连** — 锁屏、切网络后回来，画面从 tmux 完整重建

手机打开 `https://example.internal:8443/tmux/`。部署细节见 [docs/deploy.md](docs/deploy.md)。

## 开发

```bash
bun test                          # 全部测试（会真的起 tmux session，自动清理）
bun run src/index.ts --port 7682  # 本地跑
```

设计与实现计划在 `docs/superpowers/`。

## 它是怎么工作的

通过 `tmux -C attach`（control mode）跟 tmux server 通信，而不是起一个 PTY 跑 `tmux attach`。这样拿到的是**按 pane 分发**的输出流，所以能只渲染一个 pane，不带 tmux 的分屏和 status bar。

每个连接建一个 `web-<uuid>` grouped session 作为可销毁的挂载点，断开即销毁。

**尺寸是共享的。** tmux 无法把同一个 window 用两种尺寸渲染——window 尺寸是 window 的属性。所以手机连上时该 window 会变成 80 列，桌面如果正好在看同一个 window 会被压窄。断开时会调 `resize-window -A` 把尺寸还给剩下的客户端。
