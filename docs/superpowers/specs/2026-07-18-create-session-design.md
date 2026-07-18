# 从会话列表新建 Claude Code 会话

## 问题

想在手机上开一个新任务时，必须先回到电脑前起 tmux 会话。列表页已经能查看和终止会话，缺一个创建。

## 目录不是主要变量

现有 15 个会话只分布在 4 个目录，其中 12 个都在 `/mnt/data/orbit/orbit-spec`。区分会话的是名字——`PROJ-1042`、`billing-ci`、`perf`、`chat-issue`——而这些名字无法从任何地方推断，只存在于使用者脑子里。

所以流程按「名字是主要输入、目录默认选好」来设计，而不是反过来。按目录名自动命名会让 12 个会话全叫 `orbit-spec`。

## 接口

`POST /api/sessions`，body `{ dir: string, name?: string }`。

语义是幂等的「确保存在」而非「新建」：

- `name` 显式给出且已存在 → 返回该会话，`created: false`，不新建
- `name` 留空 → 取 `dir` 的 basename，撞名则加序号（`orbit-spec`、`orbit-spec-2`…），`created: true`
- 成功返回 `{ name, created }`，前端两种情况都跳转到 `terminal.html?target=<name>`

留空与显式给名的避重行为不同是刻意的：留空时使用者的意图明确是新建，显式给名时重名更可能意味着想回到那个会话。

### 校验

- `dir` 必须存在且是目录，否则 400
- 拒绝 `web-` 开头的名字：那是 `WEB_SESSION_PREFIX`，这类会话会被 reaper 当作垃圾回收
- 拒绝空名字和只含空白的名字

## 启动命令

```
tmux new-session -d -s <name> -c <dir> "$SHELL -lc claude"
```

**必须走 login shell。** 当前 tmux server 由使用者从终端启动，环境完整，`claude` 能解析到 `/home/sam/.local/bin/claude`。但机器重启后若第一个 tmux server 由 launchd 的 web 服务创建，环境就是 launchd 的最小 PATH，`claude` 找不到，功能直接失效。login shell 会加载 profile 补回 PATH。

### 注入面

`tmux` 辅助函数以 argv 数组调用，不经过 shell，所以 `name` 和 `dir` 里的元字符是惰性的（见 `session-list.ts` 中 `killSession` 的注释）。

但 tmux 的**命令部分**例外：tmux 自己会用 `sh -c` 执行它。因此该字符串必须是不含任何使用者输入的常量。目录通过 `-c` 以 argv 传入，正好避开这一点——**绝不可以把 `dir` 拼进命令字符串**。

## 目录来源

复用 `list-sessions` 的 `#{pane_current_path}`，按出现频率排序，默认选中第一个。常见情况下只需点「创建」，无需任何输入。

列表之外提供手输路径。

## 前端

列表页加「+」按钮，复用现有 `.sheet` 样式弹出：目录单选（默认第一项）+ 名字输入（选填）+ 创建按钮。与 `confirmAndKill` 的对话框模式保持一致。

失败时在 sheet 内显示错误信息，不关闭，便于修正后重试。

## 测试

纯函数单测：

- 名字生成与序号避重
- 目录按频率排序
- 名字校验（空、纯空白、`web-` 前缀）

集成测试按 `session-manager.test.ts` 现有模式：真实建会话再清理。注意 `src/server.test.ts` 与 `src/reconnect.test.ts` 并行跑时会互相干扰而随机失败，与本功能无关。

## 明确不做

重命名、自定义启动命令、目录浏览器。
