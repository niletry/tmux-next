#!/usr/bin/env bun
import { HELP, MIN_TMUX, meetsMinimum, parseArgs, parseTmuxVersion } from "./cli";
import { startServer } from "./server";
import { migrateJiraBindings } from "./migrate-items";
import { startPlugins } from "../plugins/handlers";
// Read from package.json so `--version` can never drift from the published one.
import pkg from "../package.json" with { type: "json" };

const VERSION = pkg.version;

/**
 * Refuses to start on a tmux that cannot do what this depends on.
 *
 * Failing here is much kinder than failing later: on an old tmux the sizing
 * command is simply not understood, so the terminal comes up at the wrong
 * width and nothing ever says why.
 */
async function checkTmux(): Promise<string | null> {
  let out: string;
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return "tmux is installed but `tmux -V` failed";
  } catch {
    return "tmux was not found on PATH — install tmux first";
  }

  const found = parseTmuxVersion(out);
  const need = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;
  if (!found) {
    return `could not read a version from \`tmux -V\` (${out.trim()}); ${need}+ is required`;
  }
  if (!meetsMinimum(found, MIN_TMUX)) {
    return `tmux ${found.major}.${found.minor} is too old — ${need} or newer is required`;
  }
  return null;
}

const parsed = parseArgs(process.argv.slice(2));

if (parsed.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

if (parsed.kind === "version") {
  console.log(VERSION);
  process.exit(0);
}

if (parsed.kind === "hook") {
  const { installHook } = await import("./hook-setup");
  await installHook();
  process.exit(0);
}

if (parsed.kind === "asr") {
  const { writeAsrConfig, asrPath } = await import("./asr");
  if (!(await writeAsrConfig(parsed.key))) {
    console.error("tmux-next: that key is empty");
    process.exit(2);
  }
  console.log(`saved to ${asrPath()}`);
  process.exit(0);
}

if (parsed.kind === "error") {
  console.error(`tmux-next: ${parsed.message}`);
  console.error("try --help");
  process.exit(2);
}

const problem = await checkTmux();
if (problem) {
  console.error(`tmux-next: ${problem}`);
  process.exit(1);
}

// 迁移不放进 startServer：好几个测试文件直接调用 startServer 而不设
// TMUX_NEXT_ITEMS_PATH/TMUX_NEXT_JIRA_DIR，而 migrateJiraBindings 靠
// items.json 是否已存在来判断"是否迁过"——测试跑一次意外建出这个文件，
// 就会让用户机器上的真实迁移永久失效，绑定看起来白白丢了却没有任何
// 线索。放在这里，只有真正的 CLI 启动会触发，且失败绝不能挡住服务器起来。
try {
  await migrateJiraBindings();
} catch (e) {
  console.error("migrateJiraBindings failed", e);
}

// 跟迁移同理，不放进 startServer：至少五个测试文件直接调 startServer 而不带
// 真实凭据/env 覆盖，钩子挂在那儿会让插件在每次 `bun test` 时真的对外发请求、
// 往用户真实的 ~/.tmux-next/ 写单——只有真正的 CLI 启动会经过这里。不 await：
// 它本来就是同步函数，内核不等任何插件，插件想做异步的事自己在 start() 里
// fire-and-forget。
startPlugins();

const server = startServer(parsed.port, parsed.host);
console.log(`listening on http://${parsed.host}:${server.port}`);

// Hooks are copied into ~/.claude/hooks, so upgrading this package leaves the
// installed copies behind. A stale hook fails silently by design, so say it
// here or it will not be said anywhere. Never awaited and never fatal: this is
// a diagnostic, not a precondition.
void (async () => {
  const { staleHooks, staleHookMessage } = await import("./hook-freshness");
  const message = staleHookMessage(await staleHooks());
  if (message) console.warn(message);
})();

// Binding beyond loopback breaks the assumption the whole design rests on:
// that a reverse proxy is doing TLS and authentication.
if (parsed.host !== "127.0.0.1" && parsed.host !== "localhost") {
  console.warn(
    `warning: bound to ${parsed.host}, reachable from the network.\n` +
      "         This service has no authentication of its own.",
  );
}
