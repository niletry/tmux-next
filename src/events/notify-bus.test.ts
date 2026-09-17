import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { test, expect, afterAll, beforeEach } from "bun:test";

// Set up environment variables before importing server
process.env.TMUX_NEXT_KEY_USAGE_PATH = joinPath(
  tmpdir(),
  `ku-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_GALLERY_DIR = joinPath(
  tmpdir(),
  `gallery-notify-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_PINS_PATH = joinPath(
  tmpdir(),
  `pins-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_SESSIONS_DIR = joinPath(
  tmpdir(),
  `sessions-notify-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.CLAUDE_PROJECTS_DIR = joinPath(
  tmpdir(),
  `projects-notify-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_PUSH_DIR = joinPath(
  tmpdir(),
  `push-notify-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_VAPID_PATH = joinPath(
  tmpdir(),
  `vapid-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_NOTIFICATIONS_PATH = joinPath(
  tmpdir(),
  `notif-notify-test-${Math.random().toString(36).slice(2, 10)}.jsonl`,
);
process.env.TMUX_NEXT_LANG_PATH = joinPath(
  tmpdir(),
  `lang-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_THEME_PATH = joinPath(
  tmpdir(),
  `theme-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_ITEMS_PATH = joinPath(
  tmpdir(),
  `items-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_BINDINGS_PATH = joinPath(
  tmpdir(),
  `bindings-notify-test-${Math.random().toString(36).slice(2, 10)}.json`,
);

import { startServer } from "../server";
import { subscribe, resetBus, type AppEvent } from "./bus";

const server = startServer(0);
afterAll(() => server.stop());
beforeEach(() => resetBus());

const base = () => `http://127.0.0.1:${server.port}`;

async function notify(event: string, session: string, message?: string) {
  return fetch(`${base()}/api/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, session, message }),
  });
}

/**
 * 推送和 SSE 必须由同一个来源喂养，否则两者会对同一件事给出不同说法。这条测试钉的
 * 就是那一个来源：hook 打进来，总线上要看得见。
 */
test("attention 钩子发布成 session.attention", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const res = await notify("attention", "alpha", "需要你确认一下");
  expect(res.status).toBe(202);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.type).toBe("session.attention");
  expect(seen[0]!.session).toBe("alpha");
  expect(seen[0]!.data.message).toBe("需要你确认一下");
});

/** 本期不接 waiting/ended 的 hook 加速：轮询会在一个间隔内报同一件事。 */
test("本期 waiting 不进总线", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await notify("waiting", "alpha");
  expect(seen).toHaveLength(0);
});

/** 校验失败的请求不该在总线上留下任何痕迹。 */
test("非法事件名不发布", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const res = await notify("nonesuch", "alpha");
  expect(res.status).toBe(400);
  expect(seen).toHaveLength(0);
});
