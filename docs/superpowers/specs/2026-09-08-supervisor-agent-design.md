# 监察者：一个巡视同工作区其他会话的 agent

2026-09-08

## 问题

一个目录下经常同时跑着好几个 Claude Code 会话（这本来就是这个仓库存在的理由）。没人盯着的时候，
一个会话可能卡在权限确认上一动不动、可能问了一句需要上下文才能回答的问题却没人看见、也可能真的
卡死在某个工具调用里半小时没有任何新记录。目前唯一的信号是用户自己打开 tmux-next 逐个看。

## 不做什么

- **不给监察者写检测代码。** 判断"卡没卡住""这句话能不能替它回答"是需要理解上下文的判断，交给
  一个真正的 agent 去读、去想，而不是在 kernel 里编一套启发式规则。监察者是一个跟被监控对象平等
  的普通 Claude Code 会话，唯一的区别是它的首条提示词把职责讲清楚了。
- **不做常驻后台轮询进程。** 巡视节奏由监察者自己用 `/loop` 调节，不新增 kernel 侧的定时任务。
- **不管 pi / opencode 会话。** 判断状态的信号来自 Claude Code 独有的 transcript 结构
  （`stop_reason`），pi/opencode 没有等价文件；纳入它们意味着退化成截屏正则，覆盖面更宽但判断质
  量更差，本阶段不做，只管 Claude Code。
- **不做内核侧的"这是不是权限确认"分类。** 这仍然是监察者自己读文本去判断的事；kernel 只提供一
  个开关（是否允许它自动确认权限类提示），不解析提示内容。
- **不做接管式操作。** 监察者只能读和「补一句话」（`send-keys` 输入文本），不允许 kill 会话、不
  允许对不是自己创建的会话做任何销毁性操作。

## 一、监察者是什么

一个通过现有创建流程建出来的普通会话，只是：

1. 首条输入不是用户自己打的，而是一份固定模板（见「四、提示词模板」），把它要监控的目录、能不能
   自动确认权限、往哪写巡检日志、用哪个端口报警都填好；
2. 它自己有 shell，能直接读 `~/.tmux-next/sessions/*.json`、`~/.claude/projects/.../*.jsonl`、跑
   `tmux capture-pane` / `send-keys`——这些都是任何 Claude Code 会话本来就有的能力，不需要给它开
   任何新工具或新权限。

监控范围是"同一个目录（cwd）"：以监察者创建时绑定的 `cwd` 为准，纳入所有 `cwd` 落在这个目录下、
且 `agent` 字段缺省或等于 `claude` 的存活会话（缺省即 Claude Code，见 `src/claude-sessions.ts` 的
`SessionRecord.agent` 注释）。

## 二、一个工作区只允许一个监察者

新增登记表 `plugins/supervisor/` 状态目录下的 `registry.json`：

```json
{ "/Users/you/projects/tmux-next": { "session": "web-1234-ab12", "startedAt": 1234567890, "autoConfirmPermission": false } }
```

创建前先查这张表：

- 该 `cwd` 已有记录、且记录里的 tmux 会话仍然存活 → 不新建，返回已有的会话名，前端跳转过去。
- 记录存在但会话已经不在了（进程死了、被手动关掉）→ 视为空位，可以新建并覆盖记录。

这张表只解决"要不要新建"，不是运行时状态——监察者活着与否，永远以 tmux 会话是否存活为准，登记
表本身可能滞后，读的人（创建流程）需要用 `tmux has-session` 现查一次再决定，不能只信文件内容。

## 三、巡检记录与展示面板

新增插件 `plugins/supervisor/`，跟 `jira`、`gallery` 平级，自包含：

- **状态目录**：`pluginStateDir("supervisor")`，即 `~/.tmux-next/supervisor`（`TMUX_NEXT_SUPERVISOR_DIR`
  可覆盖），存 `registry.json` 和每个工作区一份的巡检日志 `<cwd 的安全文件名>.jsonl`（复用
  `safeBasename` 或等价的编码方式，不能直接拿 `cwd` 原文当文件名）。
- **谁写日志**：监察者自己。每轮巡视完，无论有没有发现问题，都往对应的 `.jsonl` 追加一行：

  ```json
  {"ts":"2026-09-08T10:00:00Z","checked":[{"session":"web-1-a","turn":"waiting","note":"..."}],"actions":[{"session":"web-1-a","type":"answered","detail":"..."}]}
  ```

  这跟 `notifications.jsonl` 由推送管线写、插件只读的关系是同一个模式：数据的作者不是这个插件的
  代码，插件只负责存放路径的约定和渲染。
- **API**（`plugins/supervisor/server.ts`）：
  - `GET /api/supervisor` — 当前所有登记在案且会话仍存活的监察者（cwd、会话名、
    autoConfirmPermission、起始时间）。用于页面顶部列表，也用于创建流程查重。
  - `GET /api/supervisor/log?cwd=<dir>` — 某个工作区的巡检历史，最新的在前，做一个条数上限（比如
    最近 200 行）避免日志无限增长后一次性读爆内存。
  - `POST /api/supervisor/create` — 查重 → 创建会话（复用现有 `session-create` 流程）→ 用模板渲染
    首条 prompt 并 `sendText` 灌入 → 写 `registry.json`。
- **页面**（`plugins/supervisor/public/`）：按工作区分组的时间线，一行一次巡检——时间、检查了哪
  些会话、每个的状态、有没有介入、介入了什么。巡检记录本身只读，没有针对某一行的交互式控件；页面
  顶部有一个创建监察者的表单（cwd + autoConfirmPermission 开关），这是「六、创建流程改动点」里
  已经授权的入口，不是对本节"只读"的违反——只读说的是巡检历史，不是整个页面。跟其它插件一样自带
  `style.css`，颜色只用主题变量。

日志条数超过上限之后怎么处置（滚动删除还是不管）本阶段不做，先把读的一侧限流，写的一侧留到用量
真实出现问题时再处理——这类"先观察再决定阈值"的取舍在这份设计里本来就贯穿始终（卡住的时间阈值
同理，见下）。

## 四、提示词模板

创建时把下面模板里的变量替换掉，作为首条输入 `sendText` 进新会话：`{{cwd}}` `{{selfSession}}`
`{{autoConfirmPermission}}`（`true`/`false`）`{{logPath}}` `{{port}}`（当前 tmux-next 监听的端口）。

模板全文（已经过一轮讨论定稿，实现时原样落进代码，不需要再设计）：

```
你是「监察者」。你是一个普通的 Claude Code 会话，没有专属工具，只是角色和职责不同：
你要巡视目录 {{cwd}} 下、这台机器上正在运行的其他 Claude Code 会话，防止它们卡住，
必要时替它们理解上下文并代为回答。你自己的 tmux 会话名是 {{selfSession}}，检查名单时要
排除自己。

一、找到同伴
1. 读 ~/.tmux-next/sessions/*.json（如果环境变量 TMUX_NEXT_SESSIONS_DIR 有设置，改读
   那个目录下的 *.json——这个仓库到处都支持这个覆盖，会话记录也不例外），每个文件形如
   {"id":"<claude session id>","session":"<tmux 会话名>","cwd":"...","agent":"..."}。
2. 只关心 cwd 等于或位于 {{cwd}} 之下、且 agent 缺省或等于 "claude" 的记录（缺省即 Claude Code）。
3. 用 tmux list-sessions -F "#{session_name}" 核对该 tmux 会话是否还活着；已经不在的记录跳过。
4. 排除 {{selfSession}} 自己。

二、读一个同伴的状态
Claude Code 把每个会话的完整记录写在
~/.claude/projects/<cwd 编码>/<session id>.jsonl。<cwd 编码> 的规则是：把该会话的 cwd
字符串末尾的 / 去掉，再把所有 / 和 . 换成 -（例如 /Users/you/proj → -Users-you-proj）。

只读文件尾部（比如最后 32KB，用 tail -c 32768），逐行按 JSON 解析，最新的一条判断结果覆盖前面的：
- 遇到 "type":"user" 的行 → 当前状态记为 working（球在它那边，上一句 assistant 的话作废）。
- 遇到 "type":"assistant" 且 message.stop_reason == "tool_use" → working。
- 遇到 "type":"assistant" 且 stop_reason 是 end_turn / stop_sequence → waiting，把
  message.content 里 type=="text" 的块拼起来，作为「它最后说的话」。
- 其余 type（system、attachment 等）忽略。
- 如果某一行带 timestamp 字段，记下最后一条能解析的记录的时间，用来算「已经多久没动静」。

三、判断要不要管，怎么管
- working 且很久没有新记录（比如 10 分钟以上）：先看它最后的话/工具调用像不像在跑测试、
  装依赖、编译这种正常耗时任务；看不出理由、又确实长时间没有任何新记录 → 怀疑卡住，走「上报」。
- waiting 且最后一句话是需要理解上下文才能回答的开放问题：你可以基于你对这个仓库、这个
  工作区里其他会话在做什么的理解，直接代为回答（见下面「怎么介入」）。
- waiting 且最后一句话明显是权限确认/y-n 选择类提示（例如「是否允许运行 xxx」「1. Yes 2.
  Yes, don't ask again 3. No」这种）：只有 {{autoConfirmPermission}} 为 true 时才可以代为
  确认，否则只报告、不要替它按下确认。
- 其他一切正常 → 不用管，本轮记为 noop。

四、怎么介入
1. 介入前先 tmux capture-pane -p -t "=<session>" 看一眼屏幕，确认它现在确实停在你从
   transcript 里读到的那个提示上——transcript 可能比屏幕滞后，别对着已经翻篇的画面发言。
2. 用 tmux send-keys -t "=<session>" -l "<你的回答文本>" 输入文本，再单独一次
   tmux send-keys -t "=<session>" Enter 提交。一次只发一段简短明确的回答，不要模拟多轮对话。
3. 绝不要 kill-session、绝不要对不是自己创建的会话做任何销毁性操作——你的角色是观察和补一句
   话，不是接管。

五、上报卡住的情况
调用（loopback，无需鉴权）：
curl -s -X POST http://127.0.0.1:{{port}}/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"event":"attention","session":"<那个会话名>","message":"<一句话说明为什么怀疑卡住>"}'

六、记录这一轮巡检
每轮检查完，不管有没有发现问题，都往 {{logPath}} 追加一行 JSON（一行一个对象，不要换行、
不要漂亮打印）：
{"ts":"<当前 ISO8601 时间>","checked":[{"session":"...","turn":"waiting|working|null","note":"..."}],"actions":[{"session":"...","type":"answered|notified|noop","detail":"..."}]}
note/detail 是自由文本，可能带单引号或撇号，用 printf '%s\n' '<这行 json>' >> {{logPath}}
这种单引号包住整段的写法会被文本里的单引号提前截断，写出损坏的一行、后面的内容漏到 shell
去执行，把这份追加型日志本身弄坏。改用 heredoc 追加，不需要给内容加引号：
cat <<'PATROL_EOF' >> {{logPath}}
<这行 json>
PATROL_EOF
（定界符两边的单引号防止 shell 展开里面的 $ 或反引号，不要漏掉。）不要用 > 覆盖。

七、节奏
做完一轮巡视后，调用 /loop，把这份指示原样带回去，让自己按分钟级自定步调继续巡视——发现
异常时可以缩短下一次的间隔，长时间平静就拉长间隔，没必要死板固定成某个数字。收到用户在这个
会话里直接发的消息时，优先处理那条消息，处理完再回到巡视循环。
```

## 五、安全边界小结

- 监察者能做的事——读文件、`capture-pane`、`send-keys` 输入文本——都是它作为一个普通 Claude Code
  会话本来就有的 shell 权限，没有新增任何 kernel API 把这些权限"发放"给它。这意味着**这份设计的
  安全边界完全是提示词层面的约定，不是代码强制的**：一个不遵守模板指示的监察者理论上什么都能做。
  这跟仓库里"kernel 强制边界"的一贯做法（facet 截断、超时包裹、`sanitiseGeometry`）不是同一类保
  证，是有意的取舍——见「不做什么」，这里选的是"信任一个 agent 会照着职责描述做事"，而不是去限制
  它的 shell 能力（限制了它也就没法读 transcript、发 send-keys 了）。
- `autoConfirmPermission` 默认 `false`，只在创建监察者时用户显式打开才生效。
- `/api/notify` 本身是 loopback-only 的既有约定（见 CLAUDE.md），监察者调用它跟 hook 脚本调用它
  没有区别，不新增暴露面。

## 六、创建流程改动点

- 复用现有的会话创建路径（`session-create.ts` / `createSession`）和 `sendText` 的 prime 机制，不
  新建一套建会话的代码。
- 新增：创建前查 `plugins/supervisor` 的 `registry.json` + 现查 tmux 存活情况；创建后把模板渲染
  好的首条 prompt 走 `primeSession` 灌入，并写一条 registry 记录。
- 前端入口：工作区/会话列表页加一个"创建监察者"的动作（具体挂在哪个页面、什么交互，留给实现计划
  阶段决定——这不影响本设计的边界）。

## 未决问题（记录，不阻塞实现）

- 巡检日志的保留策略（滚动删除 / 不管）未定，先不做限制，只在读接口限流。
- "很久没有新记录"的具体阈值只是提示词里的参考数字（10 分钟），不是强约束，后续如果发现监察者
  自己把握得不好，再回来调整措辞而不是改代码。
