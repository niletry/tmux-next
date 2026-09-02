import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * renderHeader（public/nav.js）在每个页面上都会加载 push.js 和 theme-apply.js
 * —— 包括插件页面 /p/<id>/。这几个模块发的每个网络请求都必须
 * 经 url() 解到应用根，否则在插件页面下会打到 /p/<id>/api/... 而不是 /api/...
 * （历史上正是这样：navigator.serviceWorker.register("sw.js") 404，
 * fetch("api/push/key") 被 safeBasename 当成坏文件名拒了）。
 *
 * 用静态扫描而不是 happy-dom 挂载：真实挂载 push.js 需要伪造
 * navigator.serviceWorker / Notification / PushManager 一整套浏览器 API，
 * 脆而间接；而这里要防的具体错误就是"这个字面量有没有经过 url()"，扫描源码
 * 直接对应这件事，并且在修复前一定会红。
 */
const SHARED_MODULES = ["push.js", "theme-apply.js"];

// 没经过 url() 包装、看起来像根相对路径的字面量：fetch("api/...")、
// fetch(`api/...`)、.register("sw.js")。
const BARE_FETCH = /\bfetch\(\s*[`"'](?:api\/|sw\.js)/;
const BARE_REGISTER = /\.register\(\s*[`"']sw\.js[`"']/;
const USES_URL = /\burl\(\s*[`"'](?:api\/|sw\.js)/;

for (const name of SHARED_MODULES) {
  test(`${name} 发请求前都过了 url()`, () => {
    const src = readFileSync(join(import.meta.dir, "..", "public", name), "utf8");
    expect(BARE_FETCH.test(src)).toBe(false);
    expect(BARE_REGISTER.test(src)).toBe(false);
    // 反向检查：这个文件确实发了根相对请求，不然上面两条断言就是空对空的。
    expect(USES_URL.test(src)).toBe(true);
  });
}

/**
 * 齿轮现在是跳一整页，不是开浮层——于是它自己变成了同一类错误的新入口：
 * 在插件页面 /p/<id>/ 上，裸的 "settings.html" 解到 /p/<id>/settings.html，404。
 *
 * 这条跟上面几条防的是同一件事，只是形状从 fetch 变成了 location.href，所以
 * BARE_FETCH 那几个正则看不见它，得单写一条。
 */
test("nav.js 跳设置页时经过 url()", () => {
  const src = readFileSync(join(import.meta.dir, "..", "public", "nav.js"), "utf8");
  expect(src).toContain("settings.html");
  // 出现在 url(...) 里面，而不是直接赋给 location.href
  expect(/url\(\s*[`"'][^`"']*settings\.html/.test(src)).toBe(true);
  expect(/location\.href\s*=\s*[`"']settings\.html/.test(src)).toBe(false);
});
