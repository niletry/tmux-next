// @ts-check
/**
 * Applies a theme to the page, and keeps the machine's choice in sync.
 *
 * Loaded by every page that shows colour, before first paint. The split from
 * themes.js is deliberate: that module is pure data and pure functions, so the
 * test suite can import it under Bun; this one touches the DOM, localStorage
 * and the network, and is only ever run by a browser.
 */

import { themeVars, uiVars, themeOf, isLight, DEFAULT_THEME } from "./themes.js";
import { url } from "./root.js";

/**
 * localStorage is a *cache*, not the source of truth.
 *
 * The machine's choice lives in ~/.tmux-next/theme.json, but fetching it is
 * asynchronous — painting the default first and correcting a moment later
 * flashes the wrong colours on every load. Reading a cached name synchronously
 * avoids that, and being wrong is self-correcting: the fetch below overwrites
 * it. On a device that has never loaded the page the cache is empty and the
 * default paints, which is the same thing that would have happened anyway.
 */
const CACHE_KEY = "termTheme";
/**
 * 界面外观的缓存键。跟终端那个分开存，而且**这个键缺失时回落到终端那个**，跟
 * 服务端 readTheme() 的规则一模一样：升级前的设备缓存里只有 termTheme，首帧
 * 照旧painted 成同一套颜色，不会闪一下默认主题再改回来。
 */
const UI_CACHE_KEY = "uiTheme";

/**
 * Writes the themes' colours onto :root. Everything else derives from these.
 *
 * 两组：`--term-*` 是终端的调色板（xterm 从同一份数据建 ITheme，所以页面和终端
 * 不会漂移），`--surface-* / --text-* / …` 是页面 chrome 的角色色，由 uiVars 算
 * 出来。分成两个函数而不是一个，是因为它们的受众不同：终端那组是对 xterm 的
 * 承诺，chrome 那组是对样式表的承诺，改其中一组不该惊动另一组。
 *
 * 现在它们连**主题名**都可以不同：终端画布一套配色，页面外壳另一套。分开的只有
 * 来源，算法一个字没动——`uiVars(ui)` 的输出集合跟以前完全一样，所以 49 种组合
 * 里没有一个新色值，themes.test.ts 的对比度断言照样覆盖得住。
 *
 * @param {string} name 终端调色板
 * @param {string} [ui] 页面外壳；省略就跟着终端走
 */
export function applyTheme(name, ui = name) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries({ ...themeVars(name), ...uiVars(ui) })) {
    root.style.setProperty(key, value);
  }
  // color-scheme 不能放进 uiVars：那里每个值都必须是 #rrggbb（有断言拦着），
  // 而这是个关键字。它决定原生滚动条、<select> 弹层、日期选择器的明暗——
  // 不写的话浅色主题下这些控件仍然是深色的。跟**界面**主题走：那些控件是外壳。
  root.style.setProperty("color-scheme", isLight(themeOf(ui)) ? "light" : "dark");
  root.dataset.theme = ui;
  root.dataset.termTheme = name;
}

/**
 * The cached names, or the default.
 *
 * @returns {{ name: string, ui: string }}
 */
export function cachedTheme() {
  try {
    const name = localStorage.getItem(CACHE_KEY) || DEFAULT_THEME;
    return { name, ui: localStorage.getItem(UI_CACHE_KEY) || name };
  } catch {
    // Private mode, or storage disabled — the default is a fine answer.
    return { name: DEFAULT_THEME, ui: DEFAULT_THEME };
  }
}

/** @param {{ name: string, ui: string }} choice */
function cache(choice) {
  try {
    localStorage.setItem(CACHE_KEY, choice.name);
    localStorage.setItem(UI_CACHE_KEY, choice.ui);
  } catch {
    // Not being able to cache costs a flash on the next load, nothing more.
  }
}

/**
 * Paints the cached themes now, then reconciles with the server.
 *
 * Returns the authoritative names once known, so a caller that renders a picker
 * can tick the right rows.
 *
 * @returns {Promise<{ name: string, ui: string }>}
 */
export async function initTheme() {
  const cached = cachedTheme();
  applyTheme(cached.name, cached.ui);
  try {
    const res = await fetch(url("api/theme"));
    if (!res.ok) return cached;
    const { name, ui } = await res.json();
    // 服务端两个字段都发，但答复是从网络上来的：认不出的那半留用缓存里的，
    // 而不是让整页掉回默认色。
    const next = {
      name: typeof name === "string" ? name : cached.name,
      ui: typeof ui === "string" ? ui : cached.ui,
    };
    if (next.name !== cached.name || next.ui !== cached.ui) {
      applyTheme(next.name, next.ui);
      cache(next);
    }
    return next;
  } catch {
    // Offline, or the server is gone. The cached theme is already painted and
    // the page is still usable; there is nothing to tell the user here.
    return cached;
  }
}

/**
 * Switches one or both themes: paints immediately, then persists.
 *
 * Painting first is what makes the picker feel instant. A failed write leaves
 * the page correct but the machine unchanged, which is why the result is
 * reported back rather than swallowed.
 *
 * 发上去的是**补丁**（只有改动的那半），本地才合并出整份来上色：服务端那边同样
 * 是合并，于是"改界面外观"这一下碰不到终端调色板。
 *
 * @param {{ name?: string, ui?: string }} patch
 * @returns {Promise<boolean>} whether the choice was stored
 */
export async function setTheme(patch) {
  const next = { ...cachedTheme(), ...patch };
  applyTheme(next.name, next.ui);
  cache(next);
  try {
    const res = await fetch(url("api/theme"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}
