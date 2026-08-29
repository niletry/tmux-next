import { test, expect } from "bun:test";
import { resolve } from "../public/root.js";

/**
 * 页面搬进 /p/<id>/ 之后，页面相对的 URL 会解析到插件目录底下。
 * 这个模块的整个存在理由，就是让共享代码按「应用根」解析而不是按页面。
 *
 * base 永远是 root.js 自己的 URL —— 它总在根上，所以从它推根是可靠的；
 * 而它在哪个前缀下被服务，推出来的根就在哪个前缀下，子路径部署因此不破。
 */

test("从根上的模块解析，指回根", () => {
  expect(resolve("https://h/root.js", "api/gallery")).toBe("https://h/api/gallery");
  expect(resolve("https://h/root.js", "new.html")).toBe("https://h/new.html");
});

test("页面在 /p/<id>/ 时仍指回根，而不是插件目录", () => {
  // 这正是 fetch("api/gallery") 会踩的坑：它会打到 /p/gallery/api/gallery。
  // resolve 的 base 是模块的 URL，不是页面的，所以不受页面深度影响。
  expect(resolve("https://h/root.js", "api/gallery")).toBe("https://h/api/gallery");
});

test("挂在反代子路径下时，根跟着前缀走", () => {
  // 绝对路径会写死成 /api/gallery，在 /tmux/ 前缀下直接 404。
  expect(resolve("https://h/tmux/root.js", "api/gallery")).toBe("https://h/tmux/api/gallery");
  expect(resolve("https://h/tmux/root.js", "p/gallery/")).toBe("https://h/tmux/p/gallery/");
});

test("查询串和片段原样带过去", () => {
  expect(resolve("https://h/root.js", "terminal.html?target=a%20b")).toBe(
    "https://h/terminal.html?target=a%20b",
  );
});
