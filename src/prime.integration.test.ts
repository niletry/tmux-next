import { test, expect, afterAll } from "bun:test";
import { tmux } from "./tmux/run";
import { primeSession } from "./tmux/prime";

/**
 * 真的建一个会话，真的敲一行字进去，真的读回来。
 *
 * 会话名带上 pid：这台机器上的 tmux 服务器是共用的，常常正跑着别人的活。带 pid 才能
 * 回答"是**我**建的吗"，清理也只清理这个前缀下的。绝不 kill-server。
 *
 * 里面跑的不是 agent，是一个 shell——但那个 shell 的启动命令先自己打印一行孤零零的
 * `❯`，再 exec 真正的登录 shell。这不是为了凑一个会通过的屏幕：一个真实登录 shell
 * 的提示符几乎不可能长成 `readyMarker`（`/^\s*(?:>|❯)\s*$/`，见 src/agents/index.ts）
 * 那样孤零零一行，硬等它自然长出这一行会跑满 20 秒预算再超时。让被测进程自己打印这
 * 一行，`primeSession` 走的每一层——真的 capture-pane、真的 marker 匹配、真的
 * send-keys、真的读回——都还是真的，只是把"这个屏幕形状为什么会出现"从"赌一个真实
 * shell 的提示符"换成了"确定性地造一个"。readyMarker 本身的取值不能因为这条测试改：
 * 它是 Task 6 用三段真实 claude 屏幕钉住的实证，改掉会让那三条断言变成谎话。
 */

const PREFIX = `tplprime-${process.pid}-`;
const made: string[] = [];

// -c 用仓库自己的目录：绝不能是个待会要删掉的临时目录。tmux 服务器会把它记成自己的
// 工作目录，删掉之后这台机器上之后建的每一个 pane 都起不来（见 CLAUDE.md）。
const DIR = new URL("..", import.meta.url).pathname;

async function makeSession(): Promise<string> {
  const name = `${PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  // 启动命令先打印一行孤零零的 ❯，再 exec 一个真正的 shell：这样屏幕从第一帧起就
  // 命中 readyMarker，不用赌某个真实提示符长成那个样子。
  const res = await tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    DIR,
    "sh",
    "-c",
    "printf '\\xe2\\x9d\\xaf\\n'; exec sh",
  ]);
  expect(res.ok).toBe(true);
  made.push(name);
  return name;
}

afterAll(async () => {
  // 只按精确名字杀本次自己建的那些。
  for (const name of made) {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

test("会话就绪之后，字被敲进去了", async () => {
  const name = await makeSession();
  // shell 起来要一点时间；prime 自己会轮询等，这里只是让第一次 capture 不至于空屏。
  await Bun.sleep(500);

  // agentId 随便传一个已知的（三个 agent 的 readyMarker 都一样），因为这条测试要证
  // 的是 primeSession 这条管道通不通，不是哪个 agent 的启动流程。
  await primeSession(name, "echo tplprime-ok", "pi");

  await Bun.sleep(1000);
  const screen = await tmux(["capture-pane", "-p", "-t", `=${name}:`]);
  expect(screen.ok).toBe(true);
  expect(screen.stdout).toContain("tplprime-ok");
}, 30_000);

test("这个会话确实是本次建的，清理只碰它", async () => {
  const others = await tmux(["list-sessions", "-F", "#{session_name}"]);
  const mine = others.stdout.split("\n").filter((n) => n.startsWith(PREFIX));
  // 断言按 pid 收窄：这台机器上别人的会话一概不数，否则这条测试在真在用这个应用的
  // 机器上会永久红（见 CLAUDE.md 里孤儿会话那一节）。
  expect(mine.sort()).toEqual([...made].sort());
});
