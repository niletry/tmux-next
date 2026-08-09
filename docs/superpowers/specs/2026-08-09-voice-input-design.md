# 语音输入

## 问题

手机上给 Claude 写指令，打字是最大的摩擦。系统输入法的语音键在 xterm.js 上不可用——iOS 听写把整段文本反复重写进 textarea，而 xterm 每次 `input` 事件都当新按键处理，"语音输入"会变成"语语音语音输入语音"。这条路试过三次，全部失败，最后回滚了（见下文"为什么不用系统听写"）。

所以走自己的路：录音，送 ASR，拿文本，插入。

## 供应商：火山引擎大模型录音文件识别极速版

`POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`，`X-Api-Resource-Id: volc.bigasr.auc_turbo`。一次请求一次返回，不需要 submit/query 轮询。

实测（2026-08-09，2.1 秒中文）：

| 事实 | 结论 |
|---|---|
| 单个 `X-Api-Key` 请求头即可鉴权 | 不需要 AppID + Token 那一对 |
| `?api_key=` 查询参数**不认**（`Invalid X-Api-Key`） | 鉴权只能走请求头 |
| CORS 白名单里**没有** `X-Api-Key` | **浏览器不能直连，必须服务端代理** |
| wav / m4a / mp3 / webm-opus / ogg-opus 全部识别成功 | 前端不需要转码 |
| `format` 字段被忽略（webm 标成 `ogg` 照样对） | 它嗅探容器；格式字段填什么都行 |
| 2.1 秒 opus = 7.5KB，往返 975ms | 体积和延迟都不构成约束 |
| 官方上限 512MB / 5 小时 | 不需要在 UI 上加时长限制 |

**必须服务端代理**这一条是设计的转折点。原本倾向"key 存服务端、页面直连"（省一跳、音频不过我们的服务器），但火山的 CORS 白名单只放行 `X-Api-App-Key`/`X-Api-Access-Key` 那套双值鉴权，单 key 走不通。代理反而带来两个好处：key 不出机器（浏览器 devtools、截图、扩展这三条暴露面消失），配置项也从两个减到一个。

## 交互

### 入口

工具行里 `⌨` 的紧邻位置加一个 `🎤`。这两个按钮是同一类东西：**决定屏幕底部那块空间归谁**。

点 `🎤` → 调用现有的 `closeKeyboard()`（`terminal.js:457`，`term.blur()` 让 iOS 收起键盘）→ 语音面板升到腾出来的位置。面板高度约 240px（接近键盘），`.term-page` 的 `height: var(--app-height)` 与 flex 布局会自动压缩终端区——**和键盘弹出走的是同一条布局路径**，不引入新的尺寸逻辑。

`⌨` 与 `🎤` 互斥：任一时刻底部只有一个占位者。再点 `🎤` 或点面板的关闭键收起。

`GET /api/asr` 返回 `{ enabled: false }` 时，`🎤` 根本不渲染——与 agent 可用性探测同一套路，没配置的人看不见半残的功能。

### 三态

```
待录      [ ●  轻点开始说话 ]

录音中    [ ■ 停止 ]  0:12  ▁▃▅▂▁     [取消]

识别后    ┌────────────────────────┐
          │ 把 hook 里那个         │  ← 可编辑 textarea
          │ display-message 换掉   │
          └────────────────────────┘
          [重录]              [插入]
```

**一个状态按钮来回切**：`●` 点下去变 `■`，再点回到待录。不是按住说话，也不是"开始"和"停止"两个并排的键——同一块位置、同一个手指落点，状态由图标和颜色表达。

给 Claude 的指令通常十几到几十秒，中间要停下来想；按住说话会把拇指钉住，且一松手就结束，忘词就废了。计时器常驻可见，**不设自动停止上限**。

`取消`只在录音态出现，丢弃这一段、不送识别。

### 识别结果先复核，不直接进终端

ASR 会错，人名和术语尤其。在 tmux 提示符里用手机改一行字是酷刑，所以复核放在面板的原生 `textarea` 里——这时系统键盘可以照常弹出来改。

「插入」走 `send(text)`，**不带回车**，与图片路径那条路的约定一致（`terminal.js` 注释：*no Enter, so the user adds their own words and sends*）。用户自己按 `⏎`。不提供「插入并发送」：说错了就发出去，代价不对称。

### 麦克风流的生命周期

**面板打开时 `getUserMedia`，面板关闭时 `stop()` 所有 track。**

不在按下录音键时才申请：首次会弹授权框，等用户点完，开头那个字已经被吃掉了。也不常驻：iOS 在录音期间显示系统级指示器，面板关着还亮着是失信。绑定到面板的生命周期，指示器的亮灭恰好等于"这个面板开着"，是诚实的。

授权被拒时，面板显示说明文字而不是空白按钮。

## 服务端

```
GET  /api/asr    → { enabled: boolean }
POST /api/asr    body: 原始音频字节（Content-Type: audio/*）
                 → 200 { text: "…" } | 4xx/5xx { error: "…" }
```

`POST` 把请求体 base64 后加 `X-Api-Key` / `X-Api-Resource-Id` 转发给火山，取 `result.text` 回给页面。

**音频不落盘。** 内存里过一道就丢。录音比终端内容更敏感，留在磁盘上没有任何收益。

`/api/notify` 是回环限定的，这个**不能**——它必须由浏览器经反代调用。所以它和其余端点一样，靠反代的鉴权兜底，符合 `SECURITY.md` 既有的立场。

配置读 `~/.tmux-next/asr.json`，`TMUX_NEXT_ASR_PATH` 可覆盖，路径在函数内惰性求值——遵守"每个磁盘状态路径都可用环境变量覆盖"的既有约定，使测试不碰用户的 `~/.tmux-next/`。

```json
{ "key": "…", "resourceId": "volc.bigasr.auc_turbo" }
```

`resourceId` 可省，默认 `volc.bigasr.auc_turbo`。留这个字段是因为火山换模型时只改资源 ID，不必改代码。

## 配置方式

```
bunx tmux-next asr <key>
```

与既有的 `bunx tmux-next hook` 同构。写 `~/.tmux-next/asr.json` 并 `chmod 600`。

不做网页表单：页面本身没有鉴权，让一个密钥经由无鉴权的表单落盘，比让用户跑一条命令糟糕得多。

## 代码落点

| 文件 | 改动 |
|---|---|
| `src/asr.ts` | 读配置、转发火山、取文本（新） |
| `src/asr.test.ts` | 缺配置降级、请求构造、错误映射（不打真实接口） |
| `src/server.ts` | `GET/POST /api/asr` 两个分支 |
| `src/cli.ts` / 入口 | `asr <key>` 子命令 |
| `public/voice-recorder.js` | MediaRecorder 状态机、计时（`// @ts-check` + JSDoc） |
| `src/voice-recorder.test.ts` | 假 MediaRecorder 驱动状态机 |
| `public/voice-panel.js` | 面板 DOM |
| `src/voice-panel.test.ts` | happy-dom 挂载并断言三态 |
| `public/terminal.js` | `🎤` 按钮、与 `⌨` 互斥 |
| `public/terminal.html` | 按钮标记 |
| `public/style.css` | 面板与按钮样式（**不加颜色字面量**，走 `--term-*`） |
| `public/i18n.js` | 新键 × 中英双份 |
| `README.md` / `README.zh-CN.md` | 配置说明、费用提示 |

## 测试

**不打真实火山接口。** 要花钱，也会让 CI 依赖网络和一个私密凭据。`src/asr.test.ts` 用桩 fetch 断言请求头、请求体形状和错误映射；真实连通性已在设计阶段人工验证并记录在上面那张表里。

`voice-recorder.js` 是纯状态机，可穷举：开始 → 停止 → 拿到 blob；开始 → 取消 → 不产出；未授权 → 不进入录音态；重复点击开始不叠加。用假 MediaRecorder 驱动，不需要浏览器。

`voice-panel.test.ts` 按"会渲染的浏览器模块必须有渲染测试"那条规矩挂真实 DOM，断言三态各自渲染出对应控件。DOM 垫片必须在 `afterEach` 里还原它替换掉的全局对象——`fetch` 被覆盖一次曾让另外 38 个测试失败。

`i18n.test.ts` 自动覆盖新键的完整性，不需要额外动作。

## 为什么不用系统听写

iOS 听写在 xterm.js 上的行为已实测（18.7 / Safari 26.5）：所有块都是 `insertText`，`isComposing` 恒为 false，没有 composition 事件。不清空 textarea 时 `data` 是累积的且整体替换，另有一次约 28 秒后的重放。三次修复尝试全部失败：

1. `input` 捕获阶段 + `stopImmediatePropagation` —— xterm 在 `open()` 里注册的捕获监听器更早，永远赢
2. `beforeinput` + `preventDefault` —— 听写的 beforeinput 似乎不可取消
3. 在 `send()` 里过滤 —— 摧毁了所有输出，因为 `term.onData(send)` 同时承载粘贴、图片路径和鼠标序列（都没有 keydown）

结论：**输入法层面的听写与 xterm 的输入模型不兼容**，绕不过去。自己录音送 ASR 是唯一可控的路径。

## 不做什么

- **不做流式识别。** WebSocket 流式能边说边出字，但要在前端切分音频帧、维护连接状态、处理中间结果与最终结果的替换。一次请求一次返回已经不到 1 秒，为一个"说完就出"的功能引入长连接不划算。
- **不做本地识别。** WebSpeech API 在 iOS Safari 上不可用。
- **不做自动发送。**
- **不做时长限制。**
- **不做多语言识别选择。** 大模型版本自动判语种。
