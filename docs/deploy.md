# 部署

## 地址

手机打开 `https://example.internal:8443/tmux/`，用现有的 Basic Auth 账号（与 ttyd 相同）登录。

## 服务

由 launchd 常驻，开机自启，崩溃自动重启。

- plist：`~/Library/LaunchAgents/local.tmux-next.plist`
- 监听：`127.0.0.1:7682`（**只监听 loopback**，公网访问必须经过 Caddy）
- 日志：`~/.tmux-next/logs/server.log`、`~/.tmux-next/logs/server.err`

  刻意不放 `/tmp`：macOS 会定期清理那里，日志在出事前就被删掉，等你去看现场时只剩空目录。
  launchd 不会自己创建目录，改路径时要先 `mkdir -p`，否则服务起不来且没有任何提示。

常用操作：

```bash
launchctl list | grep tmux-next          # 查看是否在跑
launchctl unload ~/Library/LaunchAgents/local.tmux-next.plist   # 停
launchctl load   ~/Library/LaunchAgents/local.tmux-next.plist   # 起
tail -f ~/.tmux-next/logs/server.log     # 看日志
```

改完代码要重启服务才生效（unload 再 load）。

## Caddy

配置在 `/opt/homebrew/etc/Caddyfile`，站点块 `example.internal:8443` 内。跑的是 `~/.local/bin/caddy-cf`（带 Cloudflare DNS 插件的构建）。

新增了两段，与 ttyd 那套并存、互不影响：

```
	# WebSocket 用 cookie 认证（浏览器 WS 握手不带 Basic Auth）
	@tmuxws path /tmux/ws
	handle @tmuxws {
		@notmuxcookie not header Cookie *ttyd_auth=...*
		respond @notmuxcookie 403
		uri strip_prefix /tmux
		reverse_proxy 127.0.0.1:7682
	}

	redir /tmux /tmux/

	handle_path /tmux/* {
		basic_auth { lcm <bcrypt> }
		header +Set-Cookie "ttyd_auth=...; Path=/; Secure; HttpOnly; SameSite=Strict"
		reverse_proxy 127.0.0.1:7682
	}
```

cookie 那一段是必需的：浏览器发起 WebSocket 握手时**不会**带 Basic Auth 头，所以先在普通请求上种 cookie，WS 再凭 cookie 放行。这是沿用 ttyd 已经在用的方案。

重载（不中断 ttyd）：

```bash
caddy-cf reload --config /opt/homebrew/etc/Caddyfile --adapter caddyfile
```

## 验证部署是否正常

```bash
R="--resolve example.internal:8443:127.0.0.1"
B="https://example.internal:8443"

curl -sk $R -o /dev/null -w "%{http_code}\n" $B/tmux/          # 期望 401（要认证）
curl -sk $R -o /dev/null -w "%{http_code}\n" $B/tmux/ws        # 期望 403（cookie 门禁）
curl -sk $R -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: ttyd_auth=..." $B/tmux/ws                        # 期望 400（已到达服务）
```

从本机 curl 必须带 `--resolve`，否则 SNI 不对，TLS 握手会失败。

## 端口占用

| 端口 | 用途 |
|---|---|
| 7681 | ttyd（原有，未改动） |
| 7682 | 本服务 |
| 8443 | Caddy HTTPS |
| 2019 | Caddy admin API（loopback） |

## 回滚

```bash
launchctl unload ~/Library/LaunchAgents/local.tmux-next.plist
rm ~/Library/LaunchAgents/local.tmux-next.plist
# 再从 Caddyfile 里删掉上面两段，然后 caddy-cf reload
```

删掉 Caddy 那两段即可完全恢复到接入前的状态，ttyd 不受影响。
