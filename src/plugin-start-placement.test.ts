import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `startPlugins()` 必须由 CLI 入口调，不能由 startServer() 调。
 *
 * 至少五个测试文件直接调 startServer。钩子挂在那儿，跑一次 `bun test` 就会让插件
 * 拿用户真实的凭据发请求、往用户真实的 ~/.tmux-next/ 写单。一模一样的事在迁移上
 * 发生过一次，migrateJiraBindings() 因此被移到 src/index.ts。
 *
 * 这条钉住落点：不钉的话，一次"顺手收拢启动逻辑"的重构就能把它挪回去，而全套测试
 * 照样绿——只在用户自己机器上、只在他跑测试时出事。
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");

test("src/server.ts 不调 startPlugins", () => {
  expect(read("./server.ts")).not.toContain("startPlugins");
});

test("src/index.ts 调 startPlugins", () => {
  expect(read("./index.ts")).toContain("startPlugins");
});
