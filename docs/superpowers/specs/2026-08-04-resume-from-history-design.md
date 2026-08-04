# 新建会话时从历史 Claude 对话恢复

## 问题

现有的「会话恢复」只处理 tmux 会话**已经死了**的情况(`restorable` 明确过滤掉还活着的),把它按 hook 记录重建回来。

缺的是另一件事:在**新建 tmux 会话**时,直接 `claude --resume` **任意一段历史对话**——不管那段对话原来的 tmux 会话还在不在。等于「开个新会话,接着某段旧对话聊」。用 hook 记录不行,它只覆盖装了 hook 之后、且已死的会话;真正的历史全集在 `~/.claude/projects/`。

## 数据来源

Claude 把每段对话存成 `~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`,一个 jsonl 一段对话,uuid 命名,**按 cwd 分目录**。

- 目录编码:cwd 的 `/`、`.` → `-`(实测 `/Users/you/projects/tmux-next` ↔ `-Users-you-projects-tmux-next`)。
- 每个 jsonl 头部有 `{"type":"ai-title","aiTitle":"…"}`——Claude 生成的对话标题,比首条原话精炼。
- jsonl 内每条记录带 `cwd` 字段,是权威的目录归属(用来兜底校验编码是否命中)。

`claude --resume <id>` 是**跟 cwd 绑定的**:现有 `restoreRecord` 就是先 `new-session -c <cwd>` 再 resume。所以候选对话**按选中的目录圈定**——先选目录,再列该目录下的历史。

## 流程

新建对话框里选好目录后,自动拉取该目录的历史对话列成一段;可选点一条 → 「创建」时 `claude --resume <id>` 进新会话;不点就照常开新对话。

## 后端

### 新模块 `src/claude-history.ts`

- `historyDir()`:`process.env.CLAUDE_PROJECTS_DIR || ~/.claude/projects`(仿 `sessionsDir()` 的 env 覆盖,便于测试)。
- `encodeProjectDir(dir)`:`dir.replace(/[/.]/g, "-")`,得到 projects 下的文件夹名。纯函数,单测。
- `parseHistoryHead(text)`:纯函数,输入 jsonl 头部若干行,输出 `{ title, cwd }`。`title` 优先 `aiTitle`,回退到第一条 `type==="user" && message.role==="user"` 的文本内容(content 可能是 string 或 block 数组,取 text 拼接);都没有则 `null`。`cwd` 取第一条带 `cwd` 的记录。单测喂样本文本。
- `listHistory(dir)`:
  1. 定位 `historyDir()/encodeProjectDir(dir)/`,不存在 → 返回 `[]`。
  2. 列 `*.jsonl`,对每个:**流式只读头部**(逐行,读到拿齐 title+cwd 或到上限 ~200 行/~64KB 就停——文件可达数十 MB,绝不整读),`stat` 取 mtime。
  3. 只保留 `cwd === dir` 的(权威过滤,兜住编码 edge case)。
  4. 按 mtime 倒序,截前 **20** 条,返回 `[{ id, title, mtime }]`(`id` = 去掉 `.jsonl` 的文件名)。**v1 不去重**(fork/resume 产生的重复条目原样列出,以后再说)。

### API

`GET /api/history?dir=<path>` → `{ conversations: [{ id, title, mtime }] }`。dir 走现有 `resolveDirectory`;解析不了 → 400。目录没有历史 → `{ conversations: [] }`,200。

### 创建支持 resume

`POST /api/sessions` body 增加可选 `resume: string`。

- 在 `session-create.ts` 加 `resumeCommand(id, skipPermissions)`:先用现有 `RESUME_ID`(`/^[A-Za-z0-9-]{1,64}$/`)校验 id,不合法返回 `null`;合法则返回固定字符串 `exec "$SHELL" -lc "claude --resume <id>"`,跳过权限时追加 ` --dangerously-skip-permissions`。照 `restoreRecord` 的「先校验再拼」——id 是唯一进入命令串的请求输入,且被收窄到 id 安全字符集。
- `createSessionResponse`:若 `body.resume` 存在,`resumeCommand(body.resume, body.skipPermissions)`;为 `null`(非法 id)→ 400 `{error:"invalid"}`;否则用它当 `command` 调 `createSession`。无 `resume` 时维持现有 `launchCommand(skipPermissions)`。

`resume` 与幂等的「确保存在」有交互:显式 `name` 且已存在时,现有逻辑直接返回那个会话、不新建——此时 `resume` 被忽略(不会把 resume 塞进一个已存在的会话)。这是可接受的:重名返回旧会话本就是「带我回去」的语义。

## 前端(create-sheet.js)

- `browse()` 选定目录后,`fetch("api/history?dir="+current)`,渲染一段「历史对话」:每行 `标题 + 相对时间`(复用 list.js 的相对时间口径)。标题为 `null` 时显示 uuid 前 8 位兜底。
- 点一行 → 高亮、记 `selectedResumeId`;再点同一行取消。切换目录清空选中。
- 提交 payload:选中了带 `resume: selectedResumeId`。选中时「创建」按钮文案 → 「恢复对话」。
- 目录无历史 → 该段显示「这个目录没有历史对话」,开新对话照常。
- 样式:历史行复用 `dir-row` 一类的既有样式,选中态加个高亮类。

## 错误与边界

- 没有对应 projects 文件夹 / 空 → 空段,开新对话不受影响。
- 非法 resume id → 400,前端按现有 `ERRORS` 映射提示。
- **恢复一段此刻正在别的活会话里跑的对话** → Claude 可能拒绝或 fork。**v1 不特殊处理**,记为已知边界。
- 巨大 jsonl → 只读头部 + 行/字节上限,绝不整读。
- 编码 edge case(路径含空格/`_`/unicode)导致文件夹没命中 → 该目录显示无历史(优雅降级,不会错列),以后需要再补。

## 测试

- **纯逻辑单测**:`encodeProjectDir`(路径→文件夹名)、`parseHistoryHead`(aiTitle 命中 / 回退首条 user / content 为数组 / 都没有)、`resumeCommand`(合法 id、非法 id 拒绝、跳过权限拼接)。
- **集成**:
  - `/api/history` 打一个临时假 `CLAUDE_PROJECTS_DIR`(写几个构造的 jsonl),断言返回的 title/排序/上限/cwd 过滤。
  - 带 `resume` 创建时,断言真起了 `claude --resume <id>`(照现有测试读 `#{pane_start_command}`);非法 id 返回 400。

## 不做(YAGNI)

- 去重/收拢 fork(v1 全列)。
- 跨目录/全局搜索历史(只按选中目录圈定)。
- 历史对话的更多预览(末条消息、消息数等)。
- 处理「重复恢复同一段正在跑的对话」。
