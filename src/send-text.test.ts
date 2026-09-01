import { test, expect, afterAll } from "bun:test";
import { sendText, MAX_TEXT } from "./tmux/send-text";
import { tmux } from "./tmux/run";

/**
 * 往会话里敲一行字。
 *
 * 真的开一个 tmux 会话来跑——这个仓库的 tmux 测试都是这么做的，因为 `send-keys`
 * 的行为（尤其 `-l` 与键名查表的区别）只有真 tmux 说了算。
 *
 * 会话名带自己的 pid，用完在 afterAll 里按精确名字销毁：绝不碰不是本次创建的会话。
 */

const NAME = `sendtext-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let made = false;

async function ensure() {
  if (made) return;
  await tmux(["new-session", "-d", "-s", NAME, "-c", process.cwd()]);
  made = true;
}

/** 会话里当前那一屏。 */
async function screen() {
  // 目标末尾那个冒号不能少：capture-pane 跟 send-keys 一样收的是 target-pane，
  // `=name` 会被当成窗格名找不到。第一版这里漏了，于是三条断言都看到空屏。
  const got = await tmux(["capture-pane", "-p", "-t", `=${NAME}:`]);
  return got.ok ? got.stdout : "";
}

afterAll(async () => {
  if (made) await tmux(["kill-session", "-t", `=${NAME}`]);
});

test("敲进去的字出现在会话里", async () => {
  await ensure();
  await sendText(NAME, "echo hello-from-test");
  await Bun.sleep(400);
  expect(await screen()).toContain("hello-from-test");
});

test("以键名开头的一句话是文字，不是按键", async () => {
  // 不带 -l 的话，send-keys 会把 "Enter" 当键名查表，这句回复就变成了一次回车。
  await ensure();
  await sendText(NAME, "echo Enter C-c q");
  await Bun.sleep(400);
  expect(await screen()).toContain("Enter C-c q");
});

test("带 shell 元字符的一句话原样进去，不被解释", async () => {
  // 走 tmux(argv) 而不是 Bun.$，所以 `$(…)` 只是几个字符。
  await ensure();
  await sendText(NAME, "echo 'a $(id) b'");
  await Bun.sleep(400);
  const out = await screen();
  expect(out).toContain("$(id)");
  expect(out).not.toContain("uid=");
});

test("空白一律拒绝，不往会话里塞一个空回车", async () => {
  expect(await sendText(NAME, "   ")).toEqual({ ok: false, reason: "empty" });
  expect(await sendText(NAME, "")).toEqual({ ok: false, reason: "empty" });
});

test("超长拒绝——把一整个文件粘进来在 TUI 里是灾难", async () => {
  expect(await sendText(NAME, "x".repeat(MAX_TEXT + 1))).toEqual({ ok: false, reason: "toolong" });
});

test("这个应用自己的挂载会话不能当收件人", async () => {
  // 它们是浏览器的接入点，往里面敲字只会落到别人的窗口上。跟 killSession 同一条判断。
  expect(await sendText(`web-${process.pid}-abc`, "hi")).toEqual({ ok: false, reason: "internal" });
});

test("不存在的会话报 internal，而不是假装成功", async () => {
  expect(await sendText(`no-such-${process.pid}`, "hi")).toEqual({ ok: false, reason: "internal" });
});
