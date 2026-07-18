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

- `dir` 必须存在、是目录，且落在允许的根之内（见「列举范围」），否则 400
- 拒绝 `web-` 开头的名字：那是 `WEB_SESSION_PREFIX`，这类会话会被 reaper 当作垃圾回收
- `name` 字段缺失或未提供表示「自动生成」；提供了却只含空白则是错误，拒绝

`dir` 与 `GET /api/dirs` 受同一套根限制，且用同一个函数判定。只限制列举而不限制创建等于没限制——直接 POST 一个根外路径就能绕过。

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

### 浏览与补全

去别的目录时靠一个输入框加候选列表：不输入时列出当前层级的子目录，点一下进入下一级；输入时按子串过滤当前层级。手机上点击远比打字轻松，所以零打字必须能走到任何允许的目录。

`GET /api/dirs?path=<abs>` 返回 `{ path, parent, entries: [{ name, path }] }`，只含目录。

隐藏点目录，否则手机上的列表会被 `.git`、`.cache` 之类淹没。

### 列举范围

限制在两个根之下：`os.homedir()` 与 `/mnt/data`。现有会话的目录全部落在这两个根内。用 `os.homedir()` 而非写死 `/home/sam`，因为家目录本就不该硬编码；`/mnt/data` 是这台机器上的外部卷，作为常量即可。

服务只监听 loopback 且认证交给 Caddy，但这个接口毕竟会把目录结构暴露出去，没有理由让它覆盖整个文件系统。

校验方式是先 `realpath` 解析再检查前缀，一步同时挡住 `..` 和指向根外的符号链接。比较时按路径分隔符边界比对，避免 `/home/samuel` 因前缀匹配 `/home/sam` 而放行。越界返回 403。

## 前端

列表页加「+」按钮，复用现有 `.sheet` 样式弹出，与 `confirmAndKill` 的对话框模式保持一致。sheet 内自上而下：

1. 常用目录（来自现有会话，频率排序，默认选中第一项）
2. 当前路径，可点父级回退
3. 输入框与候选列表（上面的浏览与补全）
4. 名字输入（选填）
5. 创建按钮

失败时在 sheet 内显示错误信息，不关闭，便于修正后重试。

## 测试

纯函数单测：

- 名字生成与序号避重
- 目录按频率排序
- 名字校验（空、纯空白、`web-` 前缀）
- 路径越界判定：`..` 逃逸、根外的符号链接、恰好等于根本身、根的前缀近邻（`/home/samuel` 不该因 `/home/sam` 而放行）

集成测试按 `session-manager.test.ts` 现有模式：真实建会话再清理。注意 `src/server.test.ts` 与 `src/reconnect.test.ts` 并行跑时会互相干扰而随机失败，与本功能无关。

## 明确不做

重命名、自定义启动命令、跨根目录的全局模糊搜索、新建目录。
