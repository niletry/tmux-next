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
 * 照样绿——只在用户自己机器上、只在他跑测试时出事，这也是这条守卫必须钉得死死的
 * 原因：CI 永远看不见这个失败，唯一能看见的人是正在跑测试的用户自己。
 *
 * 正向那条断言必须认「调用」，不能认「提到这个名字」——`import { startPlugins }
 * from "../plugins/handlers"` 这行本身就含 "startPlugins" 这个子串，光 toContain
 * 的话，有人重构时手滑删掉 `startPlugins();` 这条语句、留下现在没用的 import，
 * 这条测试照样绿（tsconfig 没开 noUnusedLocals，也没别的东西会替它报这个死 import）。
 * 真正要钉住的要求从来不是"这个标识符出现过"，而是"CLI 路径上，插件在服务器开始
 * 服务之前拿到一次启动机会"——所以断言调用语法本身（`startPlugins(...)`），并且
 * 断言它出现在 `startServer(` 之前。
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");

test("src/server.ts 不调 startPlugins", () => {
  expect(read("./server.ts")).not.toContain("startPlugins");
});

test("src/index.ts 在 startServer(...) 之前调用 startPlugins()", () => {
  const src = read("./index.ts");
  const callMatch = src.match(/\bstartPlugins\(\s*\)/);
  expect(callMatch).not.toBeNull();

  const callIndex = callMatch!.index!;
  const serverIndex = src.indexOf("startServer(");
  expect(serverIndex).toBeGreaterThan(-1);
  expect(callIndex).toBeLessThan(serverIndex);
});
