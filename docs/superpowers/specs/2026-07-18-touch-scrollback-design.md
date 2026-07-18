# 触摸滑动查看历史输出

## 问题

iOS Safari 上在终端里向上滑动没有任何反应，看不到历史输出。

原因有两层：

1. web session attach 到 tmux，tmux 用绝对定位重绘整屏，**永远不会让行滚出屏幕顶部**，所以 xterm 的 scrollback 恒为空，`public/terminal.js` 里的 `scrollback: 5000` 一行都存不进去。
2. 移动端 xterm 的触摸滑动走的是 viewport 原生滚动，滚的正是那个空的 scrollback，于是毫无效果。

目标是滚动**全屏程序（Claude Code、vim、less）自己的内容**。这类程序跑在 alternate screen 里，内容不进 tmux scrollback，因此 `copy-mode` 和 `capture-pane -S` 两条路都无效——它们只会滚到一片空白。唯一可行的是把滚动动作转成程序自己能理解的输入。

## 方案

接管 `termEl` 上的触摸手势，累积垂直位移，每满一行就合成一个 `WheelEvent` 派发给 xterm，由 xterm 自己编码成鼠标序列。

**不手拼 SGR 字节。** xterm 的 wheel 分支直接走 `coreMouseService.triggerMouseEvent`，会按程序当前协商的鼠标协议（X10 / VT200 / SGR）编码。自己拼字节等于把协议适配重写一遍，且必然在某些程序上错。

合成的事件用 `deltaMode: DOM_DELTA_LINE`，因为 xterm 的 wheel 分支里有一道 `if (0 === viewport.getLinesScrolled(t)) return false` 的门槛，按行给 delta 能稳定跨过它；按像素给则要依赖行高换算，容易算出 0 而被静默丢弃。

滚动方向遵循「内容跟随手指」：手指向下滑 = 看更早的内容 = wheel up。

## 降级：程序没开鼠标上报时发 PgUp/PgDn

xterm 只在程序请求了 wheel 能力时才绑定 wheel 监听器（`16 & capabilities`）。程序没开鼠标上报时监听器根本不存在，派发的事件不会产生任何输出。

据此判定降级，靠同步观测 `onData`：xterm 的鼠标编码是同步走到 `triggerDataEvent` → `onData` 的，所以派发前清标志、派发后立即检查即可。这与 `terminal.js` 里 IME 修复所用的 `lastSent` 去重是同一套模式。

判定为无效时，改发 PgUp（`1b 5b 35 7e`）/ PgDn（`1b 5b 36 7e`）。

已知代价：对既不支持鼠标、翻页键又另有含义的程序，这会误触发。接受——覆盖面比精确性更重要。

## 与现有代码的冲突

**必须区分 tap 和 swipe。** `public/terminal.js:140` 现在是 `termEl.addEventListener("touchend", openKeyboard)`，滑动结束手指抬起会弹出键盘。改为只在总位移小于阈值（约 10px）时才算 tap 才弹键盘。这是本次改动里最容易被漏掉、也最影响手感的一点。

**`touchmove` 需 `{passive: false}` 并 `preventDefault`**，否则 Safari 的页面橡皮筋会盖过手势。

服务端不改动：合成事件最终走既有的 `term.onData` → `send()` → `sendKeys` 链路。

## 验证

单元测试覆盖不到触摸手势。核心逻辑（位移累积成行数、方向映射、降级判定）应抽成纯函数以便测试，但**手势在 iOS Safari 里的真实表现必须在真机上确认**：

- 在 Claude Code 里上滑能看到历史，下滑能回到底部
- 在不开鼠标的程序（如裸 bash）里上滑触发 PgUp
- 轻点仍能弹出键盘，滑动不会误弹

注意 `src/server.test.ts` 与 `src/reconnect.test.ts` 并行跑时会互相干扰而随机失败，与本改动无关。
