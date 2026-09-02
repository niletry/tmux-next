# 浅色主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给应用增加三套浅色主题（Tokyo Night Day / Catppuccin Latte / One Light），并修好现有 `uiVars()` 在浅色极性下失效的三处缺陷。

**Architecture:** 浅色不是新状态轴，只是 `THEMES` 多三条数据——`theme.json` 仍然只存一个名字，持久化、`applyTheme`、`initTheme` 全部不动。一套主题「是深是浅」由 `luminance(background) > luminance(foreground)` 算出来，不新增字段。`uiVars()` 里所有「朝某个端点推到过线为止」的构造改为按极性选端点（深色朝 `#ffffff`，浅色朝 `#000000`）。终端调色板 `themeVars()`/`xtermTheme()` 与 `terminal.js` 一行不改。

**Tech Stack:** Bun（无构建步骤）、纯 ES 模块前端、`bun:test`。无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-02-light-themes-design.md` —— **必读，含全部实测数据与被否掉的替代方案。**

## Global Constraints

- **`bun` 不在 PATH 里。** 一律用 `~/.bun/bin/bun`。跑测试：`~/.bun/bin/bun test src/themes.test.ts`；类型检查：`~/.bun/bin/bun run typecheck`。
- **提交信息不带任何助手署名。** 不写 `Co-Authored-By: Claude …`、不写 `Claude-Session:`、不写 `🤖 Generated with …`。这个仓库是公开的，历史被清洗过一次，不能再沾。正文里提 Claude Code 没问题，规则针对的是署名尾注。
- **`git add` 必须列具体文件，禁止 `git add -A` / `git add .`。** 同一个仓库常有多个会话并行，`-A` 会扫走别人的在途改动。
- **每个颜色都是小写 `#rrggbb`。** `themes.test.ts` 的 `HEX = /^#[0-9a-f]{6}$/` 会拒绝其它写法，对比度运算也直接按这六位解析。
- **`themes.test.ts` 的 `GRANDFATHERED` 名单维持 4 条，只许变短不许变长。**
- **`uiVars()` 的返回值必须全是 `#rrggbb`。** 现有断言 `%s: uiVars 的每个值都是 #rrggbb` 会拦。`color-scheme` 是关键字不是颜色，**绝不能放进 `uiVars()`**，它属于 `theme-apply.js`。
- **不改四套深色主题的任何调色板色值。** 唯一允许变化的深色渲染结果是 `--accent-hover`（Task 2），那是修 bug。
- **不引入「跟随系统明暗」，不做 Nord 浅色版。** 理由见规格「决策」与「不做」两节。
- 所有新增用户可见文案必须走 `public/i18n.js`，中英各一份；`src/i18n.test.ts` 会同时检查缺键、废键、和只在一种语言里存在的键。

---

### Task 1: 极性判定与 `pushTo`

把「朝哪个端点推」从写死的 `ansi[15]` 变成按极性算，并把 `liftTo` 改名为 `pushTo`——它现在两个方向都走，`lift`（提亮）这个名字会变成假话。

**Files:**
- Modify: `public/themes.js`（`liftTo` 定义处及其 3 个调用点）
- Test: `src/themes.test.ts`

**Interfaces:**
- Produces: `isLight(theme: Theme) => boolean`（导出，测试要用）；模块内 `pushTo(from, toward, on, floor) => string`（不导出，签名与原 `liftTo` 完全一致）。

- [ ] **Step 1: 写失败的测试**

加到 `src/themes.test.ts` 里 `themeOf falls back rather than returning undefined` 那条测试的后面。import 那一行要把 `isLight` 加进去。

```ts
test("isLight 读的是调色板，不是名字", () => {
  // 用合成对象而不是真主题：这条断言要说的是「极性由两个色决定」，
  // 用真主题的话，等于在断言那套主题的取值，而不是这个函数的行为。
  const light = { background: "#ffffff", foreground: "#000000" } as never;
  const dark = { background: "#000000", foreground: "#ffffff" } as never;
  expect(isLight(light)).toBe(true);
  expect(isLight(dark)).toBe(false);
});

test.each(names)("%s: 四套既有主题都判为深色", (name) => {
  expect(isLight(THEMES[name]!)).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `~/.bun/bin/bun test src/themes.test.ts -t "isLight"`
Expected: FAIL，`isLight is not a function`（或 import 报错）。

- [ ] **Step 3: 实现**

在 `public/themes.js` 里，把 `liftTo` 整个函数（连同它的 JSDoc）替换成下面这段，放在 `dimTo` 后面同一个位置：

```js
/**
 * 从 `from` 朝 `toward` 推，取第一个达标的那一步。
 *
 * 原名 `liftTo`——「提亮」，因为端点写死是主题的亮白色，只服务深色主题。浅色
 * 主题的表面本来就接近白，朝白提只会更糟，循环走完会返回纯白端点，于是
 * `--ok`/`--warn`/`--danger` 在浅色下直接消失。方向本来就该由极性决定，
 * 名字里不该有方向。
 *
 * @param {string} from   起点
 * @param {string} toward 端点，由 `farEnd()` 按极性给出
 * @param {string} on     实际用来量对比度的背景
 * @param {number} floor  对比度下限
 * @returns {string}
 */
function pushTo(from, toward, on, floor) {
  for (let step = 100; step >= 0; step -= 2) {
    const c = mix(from, toward, step / 100);
    if (contrast(c, on) >= floor) return c;
  }
  return toward;
}

/**
 * 一套主题是深是浅。
 *
 * 算出来而不是让主题自己声明：一套主题的极性完全由它的 background 和
 * foreground 决定，再写一个 `dark: true` 字段只是制造两者打架的机会。
 *
 * @param {Theme} t
 * @returns {boolean}
 */
export function isLight(t) {
  return luminance(t.background) > luminance(t.foreground);
}

/**
 * 远离表面的那一端。所有「推到过线为止」的构造都朝它走。
 *
 * 纯黑/纯白而不是主题自己的 ansi[15]：Catppuccin Mocha 的亮白 #a6adc8 和它的
 * 蓝 #89b4fa 亮度太近，朝它推最多只能推出 1.057 的差，肉眼等于没变（见
 * Task 2 的 --accent-hover）。
 *
 * @param {Theme} t
 * @returns {string}
 */
const farEnd = (t) => (isLight(t) ? "#000000" : "#ffffff");
```

然后把 `uiVars()` 里三个 `liftTo(` 调用改成 `pushTo(`，**端点参数这一步先不动**（Task 3 才改）。三处是：`--accent-alt-text`、`accentText` 的兜底、以及 `--ok`/`--warn`/`--danger`。

- [ ] **Step 4: 跑测试确认通过**

Run: `~/.bun/bin/bun test src/themes.test.ts`
Expected: PASS，全部通过。改名和加函数都不改任何计算结果。

- [ ] **Step 5: 类型检查并提交**

```bash
~/.bun/bin/bun run typecheck
git add public/themes.js src/themes.test.ts
git commit -m "refactor: 主题极性算出来，liftTo 改名 pushTo"
```

---

### Task 2: `--accent` 与 `--accent-hover` 成为算出来的令牌

现在四套主题的 `--accent-hover` **等于** `--accent`（实测 `ansi[4] === ansi[12]` 无一例外），悬停毫无反馈。同时上游浅色主题的蓝当填充时两个方向都过不了 4.5:1，填充本身必须能被压暗。

**Files:**
- Modify: `public/themes.js`（`uiVars()`）
- Modify: `public/style.css`（兜底块 `--accent-hover`）
- Test: `src/themes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `pushTo` 与 `farEnd`。
- Produces: `uiVars(name)["--accent"]` 与 `["--accent-hover"]` 保证 `contrast >= 1.15`，且 `--on-accent` 在两者上都 ≥ 4.5。

- [ ] **Step 1: 写失败的测试**

加在 `src/themes.test.ts` 的 `%s: 强调色当填充时压在上面的字读得清` 之后：

```ts
// 悬停填充必须看得出跟常态不一样。1.15 是两块填充之间刚好可辨的一档——这不是
// WCAG 的档位，WCAG 管的是文字和它的背景，不管两个状态之间的差别。
const HOVER_MIN = 1.15;

test.each(THEME_ORDER)("%s: 悬停填充跟常态填充分得出来", (name) => {
  const v = ui(name);
  expect(contrast(v["--accent"]!, v["--accent-hover"]!)).toBeGreaterThanOrEqual(HOVER_MIN);
});

test.each(THEME_ORDER)("%s: 悬停填充上的字也读得清", (name) => {
  const v = ui(name);
  expect(contrast(v["--on-accent"]!, v["--accent-hover"]!)).toBeGreaterThanOrEqual(FG_MIN);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `~/.bun/bin/bun test src/themes.test.ts -t "悬停填充跟常态填充分得出来"`
Expected: FAIL，四套主题全红，比值都是 `1`——因为 `--accent-hover` 现在就等于 `--accent`。

- [ ] **Step 3: 实现**

在 `public/themes.js` 的 `uiVars()` 里，`accentText` 那段之前插入：

```js
  const far = farEnd(t);

  // --accent 是填充，onAccent 压在它上面，所以这是正文级要求。上游调色板的蓝
  // 未必够：Tokyo Night Day 的 #2e7de9 白字压上去 4.02:1、深字约 4.2:1，
  // **两个方向都过不了**——不是 onAccent 选错了，是这个色当填充时本身不够。
  // 压的是角色令牌，终端的 ansi[4] 一个字节不动，这正是两组变量分开的意义。
  // 四套深色主题实测 4.64–7.79:1，循环第一步就过，值不变。
  const accent = pushTo(t.ansi[4], far, t.onAccent, TEXT_FLOOR);
```

把返回对象里的这两行：

```js
    "--accent": t.ansi[4],
    "--accent-hover": t.ansi[12],
```

改成：

```js
    "--accent": accent,
    // 悬停：从常态填充朝远离表面的一端推，推到跟常态色差得出来为止。以前取
    // ansi[12]（亮蓝），而七套主题的 ansi[12] 全部等于 ansi[4]——悬停色一直
    // 等于常态色，等于没有悬停反馈。这不是浅色带来的问题，是浅色让它显眼了。
    // 「远离表面」对填充和压在它上面的字是同向的，所以 onAccent 在悬停填充上
    // 只会比在常态填充上更好（实测 5.34–9.03:1），不需要再夹一次。
    "--accent-hover": pushTo(accent, far, accent, HOVER_MIN),
```

在 `MARK_FLOOR` 定义的后面加上这个常量：

```js
/** 两块填充之间刚好可辨的一档。不是 WCAG 档位——WCAG 管字和背景，不管状态差异。 */
const HOVER_MIN = 1.15;
```

同一个函数里，把 `accentText` 那三级判断

```js
  const accentText =
    contrast(t.ansi[4], s4) >= TEXT_FLOOR
      ? t.ansi[4]
      : contrast(t.ansi[12], s4) >= TEXT_FLOOR
        ? t.ansi[12]
        : pushTo(t.ansi[12], fg, s4, TEXT_FLOOR);
```

砍成两级：

```js
  // 中间那一级（试亮蓝）删掉了：七套主题的 ansi[12] **全部**等于 ansi[4]
  // （#7aa2f7 / #89b4fa / #61afef / #81a1c1，三套浅色也一样），所以第二个条件
  // 跟第一个是同一个判断，永远不可能在第一个失败之后成功——它在任何已发布的
  // 主题里都是死代码。删它不改变任何一套主题的结果。
  const accentText =
    contrast(t.ansi[4], s4) >= TEXT_FLOOR ? t.ansi[4] : pushTo(t.ansi[4], fg, s4, TEXT_FLOOR);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `~/.bun/bin/bun test src/themes.test.ts`
Expected: PASS。四套主题的 hover 变成 `#8daff8` / `#9ec2fb` / `#7abcf2` / `#93aeca`，差值 1.154–1.173。`--accent`、`--accent-text` 与其余令牌**逐字节不变**——`--accent` 在深色下第一步就过线，`accentText` 删的是死代码。

- [ ] **Step 5: 同步兜底块，删掉被取代的重复断言**

`public/style.css` 的 `:root` 兜底块里，把

```css
  --accent-hover: #7aa2f7;
```

改成（这是 Tokyo Night 算出来的新值，兜底块的职责就是「默认主题算出来的结果」）：

```css
  --accent-hover: #8daff8;
```

`src/themes.test.ts` 里**删掉**整条调色板级的断言（连同它的注释）：

```ts
test.each(names)("%s: on-accent text is readable on the accent fill", (name) => {
  const t = THEMES[name]!;
  // --accent is the theme's blue; onAccent is pressed onto it in buttons and chips.
  expect(contrast(t.onAccent, t.ansi[4]!)).toBeGreaterThanOrEqual(FG_MIN);
});
```

理由：它量的是 `t.ansi[4]`，而实际填充现在是算出来的 `--accent`。角色色一节里的 `%s: 强调色当填充时压在上面的字读得清` 已经在量正确的对象，留着这条只会在浅色主题落地时跟实现打架。

- [ ] **Step 6: 跑完整测试并提交**

```bash
~/.bun/bin/bun test src/themes.test.ts && ~/.bun/bin/bun run typecheck
git add public/themes.js public/style.css src/themes.test.ts
git commit -m "fix: 悬停填充一直等于常态填充，改成算到看得出差别为止"
```

---

### Task 3: 第一套浅色主题（Catppuccin Latte）与它顶出来的极性缺陷

这一任务里，**新数据本身就是那个失败的测试**：把 Latte 加进去，现有断言会红三处，逐一修好。

**Files:**
- Modify: `public/themes.js`（`THEMES`、`THEME_ORDER`、`uiVars()`）
- Test: `src/themes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isLight`/`farEnd`/`pushTo`，Task 2 的 `far` 局部变量。
- Produces: `THEMES["catppuccin-latte"]`。

- [ ] **Step 1: 加数据（这就是失败的测试）**

在 `public/themes.js` 的 `THEMES` 里，`nord` 之后加：

```js
  // --- 浅色 ---------------------------------------------------------------
  //
  // 三套都是上游真实存在、作者专为浅底挑过的调色板。Nord 没有官方浅色版：把
  // Aurora/Frost 搬到雪白底上是 green 1.77:1、cyan 1.74:1、yellow 1.35:1，
  // 得重挑一半色相，出来的东西不是 Nord，而且无上游可引用——以后没人能判断
  // 某个值为什么是那样。所以浅色只有三套，选择器左右不对称，但不造没有的东西。

  "catppuccin-latte": {
    label: "Catppuccin Latte",
    background: "#eff1f5",
    foreground: "#4c4f69",
    // upstream rosewater #dc8a78 → 2.34:1
    cursor: "#bd7767",
    cursorAccent: "#eff1f5",
    selectionBackground: "#bcc0cc",
    onAccent: "#ffffff",
    ansi: [
      // upstream green #40a02b → 2.96:1、yellow #df8e1d → 2.31:1、
      // pink #ea76cb → 2.34:1。都是朝纯黑压——三个通道同乘一个常数，
      // 色相与 HSV 饱和度严格不变，只动亮度。
      "#5c5f77", "#d20f39", "#3f9d2a", "#c07a19",
      "#1e66f5", "#c965af", "#179299", "#acb0be",
      "#6c6f85", "#d20f39", "#3f9d2a", "#c07a19",
      "#1e66f5", "#c965af", "#179299", "#bcc0cc",
    ],
  },
```

`THEME_ORDER` 暂时改成（Task 6 才改成分组结构）：

```js
export const THEME_ORDER = ["tokyo-night", "catppuccin-mocha", "one-dark", "nord", "catppuccin-latte"];
```

- [ ] **Step 2: 跑测试，记下红的是哪几条**

Run: `~/.bun/bin/bun test src/themes.test.ts`
Expected: FAIL，恰好三类：
1. `catppuccin-latte: 表面层级单调递增` —— 浅色的表面是朝深色抬的，亮度递减。
2. `catppuccin-latte: 语义色在表面上分得出来` —— `--ok`/`--warn` 触底返回 `ansi[15]`（`#bcc0cc`），对 surface-4 只有 1.30:1。
3. `catppuccin-latte: 边框在它所在的表面上不是隐形的` —— `--border-2` 是 1.339，低于 1.4。

（调色板级的断言全绿：数据里那三个槽位已经压过了。）

- [ ] **Step 3: 修 `uiVars()` 的语义色端点与边框**

`public/themes.js` 的 `uiVars()` 里，把语义色三行

```js
    "--ok": pushTo(t.ansi[10], t.ansi[15], s4, MARK_FLOOR),
    "--warn": pushTo(t.ansi[11], t.ansi[15], s4, MARK_FLOOR),
    "--danger": pushTo(t.ansi[9], t.ansi[15], s4, MARK_FLOOR),
```

改成：

```js
    // 端点按极性走：深色朝纯白，浅色朝纯黑。写死 ansi[15] 的话，浅色主题的
    // 表面本来就接近白，朝白推走完循环会返回端点本身——Latte 实测 --ok 和
    // --warn 双双变成 #bcc0cc，对 surface-4 只有 1.30:1，等于消失。
    "--ok": pushTo(t.ansi[10], far, s4, MARK_FLOOR),
    "--warn": pushTo(t.ansi[11], far, s4, MARK_FLOOR),
    "--danger": pushTo(t.ansi[9], far, s4, MARK_FLOOR),
```

把边框两行

```js
    "--border-1": mix(fg, bg, 0.16),
    "--border-2": mix(fg, bg, 0.32),
```

改成：

```js
    // 固定配比在深色下够、浅色下不够：Latte 的 --border-2 实测 1.339，低于
    // 「边框不能是隐形的」那条 1.4 的线。改成从原配比出发推到过线为止——
    // 深色四套第一步就过，pushTo 原样返回起点，边框色逐字节不变。
    "--border-1": pushTo(mix(fg, bg, 0.16), fg, s3, 1.12),
    "--border-2": pushTo(mix(fg, bg, 0.32), fg, s4, 1.45),
```

（1.12 / 1.45 比断言的 1.1 / 1.4 各高一点，留一格余量，免得压着线的浮点结果来回翻。）

- [ ] **Step 4: 修表面层级断言的方向**

`src/themes.test.ts` 里把 `%s: 表面层级单调递增` 整条替换成：

```ts
test.each(THEME_ORDER)("%s: 表面层级单调远离底色", (name) => {
  const v = ui(name);
  const light = isLight(THEMES[name]!);
  const steps = [1, 2, 3, 4, 5].map((i) => luminance(v[`--surface-${i}`]!));
  // 「抬高」在深色主题里是变亮，在浅色主题里是变暗——同一件事的两个极性。
  // 排反的话，所有以 surface-4 为基准算出来的文字色都会在别的表面上不达标，
  // 而每一条断言仍然是绿的：基准本身选错了。
  // 一次报全部而不是停在第一处：层级排错时想看的是整条阶梯长什么样。
  const wrong = steps
    .map((lum, i) => ({ step: i + 1, lum }))
    .filter((s, i) => i > 0 && (light ? s.lum >= steps[i - 1]! : s.lum <= steps[i - 1]!))
    .map((s) => `surface-${s.step}`);
  expect(wrong).toEqual([]);
});
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `~/.bun/bin/bun test src/themes.test.ts`
Expected: PASS。Latte 的 `--ok`/`--warn`/`--danger` 变成 `#378a25` / `#a96b16` / `#d20f39`，`--border-2` 变成 `#b2b4c0`。四套深色主题的边框与语义色**逐字节不变**。

- [ ] **Step 6: 提交**

```bash
~/.bun/bin/bun run typecheck
git add public/themes.js src/themes.test.ts
git commit -m "feat: 加 Catppuccin Latte，语义色和边框改成按极性算"
```

---

### Task 4: 另外两套浅色主题

**Files:**
- Modify: `public/themes.js`（`THEMES`、`THEME_ORDER`）
- Test: `src/themes.test.ts`

**Interfaces:**
- Produces: `THEMES["tokyo-night-day"]`、`THEMES["one-light"]`。

- [ ] **Step 1: 先写两条新的哨兵断言**

加在 `src/themes.test.ts` 的角色色一节末尾（`%s: 角色色和终端调色板互不重叠` 之前）：

```ts
// 触底的现场特征。pushTo 走完循环还没达标时会返回端点本身，而端点现在是纯黑
// 或纯白——一个算出来的令牌等于纯黑/纯白，就说明这套主题的这个颜色在这个极性
// 下根本推不出答案。--on-accent 要排除：它是从调色板直接抄的，三套浅色主题的
// 它正当地就是 #ffffff。
//
// 这条是防将来回归的哨兵，不是发现当下缺陷的工具：极性修好之前，语义色触底
// 返回的是 ansi[15]（Latte 的 #bcc0cc），这条根本抓不到——抓到它的是既有的
// 语义色对比度断言。
test.each(THEME_ORDER)("%s: 没有算出来的令牌触底成纯黑或纯白", (name) => {
  const bottomed = Object.entries(ui(name))
    .filter(([key]) => key !== "--on-accent")
    .filter(([, c]) => c === "#000000" || c === "#ffffff")
    .map(([key]) => key);
  expect(bottomed).toEqual([]);
});

// 选区必须跟底色分得开。前景在选区上读得清（上面已有断言）还不够——一块跟底色
// 同色的选区不是"淡"，是"选不出东西来"。Tokyo Night Day 的上游选区 #99a7df
// 前景对比只有 2.49:1，而只朝白提会一路退化到纯白：前景对比过线了，选区却跟
// #e1e2e7 的底色差 1.07。两条得同时满足。
test.each(THEME_ORDER)("%s: 选区跟底色分得出来", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.selectionBackground, t.background)).toBeGreaterThanOrEqual(1.15);
});
```

- [ ] **Step 2: 跑测试确认通过（这两条对现有五套主题就该是绿的）**

Run: `~/.bun/bin/bun test src/themes.test.ts -t "触底" && ~/.bun/bin/bun test src/themes.test.ts -t "选区跟底色"`
Expected: PASS。深色四套选区/底色实测 1.434–1.878，Latte 1.608。这两条现在是把既有事实钉住，等下一步加数据时才真正开始工作。

- [ ] **Step 3: 加两套调色板**

在 `public/themes.js` 的 `catppuccin-latte` 之后加：

```js
  "tokyo-night-day": {
    label: "Tokyo Night Day",
    // upstream fg #3760bf → 在自己底色上 4.52:1，刚好压线，而页面的表面是朝
    // 前景色抬的，抬到 surface-5 时 --text-1 掉到 3.54:1，--text-2 连一步都
    // 走不动。这暴露了「抬升表面」一个没写下来的隐含要求：前景对底色要有余量。
    // 四套深色主题的前景是近白色（8–11:1），大到从没暴露过。朝纯黑压 18%,
    // fg/bg 升到 5.98:1，五层表面上 4.53–5.98 全部过线。
    background: "#e1e2e7",
    foreground: "#2d4f9d",
    cursor: "#2d4f9d",
    cursorAccent: "#e1e2e7",
    // upstream #99a7df → 前景对比 2.49:1
    selectionBackground: "#b9c4ec",
    onAccent: "#ffffff",
    ansi: [
      "#b4b5b9", "#f52a65", "#587539", "#8c6c3e",
      "#2e7de9", "#9854f1", "#007197", "#6172b0",
      // upstream #848cb5 → 2.54:1
      "#777ea3", "#f52a65", "#587539", "#8c6c3e",
      "#2e7de9", "#9854f1", "#007197", "#2d4f9d",
    ],
  },

  "one-light": {
    label: "One Light",
    background: "#fafafa",
    foreground: "#383a42",
    cursor: "#526fff",
    cursorAccent: "#fafafa",
    selectionBackground: "#d4d7d6",
    onAccent: "#ffffff",
    ansi: [
      "#4f525e", "#e45649", "#50a14f", "#c18401",
      "#4078f2", "#a626a4", "#0184bc", "#a0a1a7",
      // upstream #a0a1a7 → 2.47:1
      "#909196", "#e45649", "#50a14f", "#c18401",
      "#4078f2", "#a626a4", "#0184bc", "#4f525e",
    ],
  },
```

`THEME_ORDER` 改成：

```js
export const THEME_ORDER = [
  "tokyo-night", "catppuccin-mocha", "one-dark", "nord",
  "tokyo-night-day", "catppuccin-latte", "one-light",
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `~/.bun/bin/bun test src/themes.test.ts`
Expected: PASS，七套主题全部断言通过。这两套的 `--accent` 会被 Task 2 的机制自动压暗（`#2e7de9 → #2a73d6`、`#4078f2 → #3c71e3`），无需在数据里手动改——终端的 `ansi[4]` 保持上游值。

- [ ] **Step 5: 提交**

```bash
~/.bun/bin/bun run typecheck
git add public/themes.js src/themes.test.ts
git commit -m "feat: 加 Tokyo Night Day 与 One Light"
```

---

### Task 5: `color-scheme` 按极性写

浅色主题下原生滚动条、`<select>` 弹层、日期选择器仍然是深色，因为 `color-scheme: dark` 写死在样式表里。

**Files:**
- Modify: `public/theme-apply.js`（`applyTheme`）
- Modify: `public/style.css`（`:root` 兜底块）
- Test: `src/theme-apply.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `isLight`，`themes.js` 的 `themeOf`。
- Produces: `applyTheme(name)` 除写 CSS 变量外，还写 `color-scheme`。

- [ ] **Step 1: 写失败的测试**

新建 `src/theme-apply.test.ts`：

```ts
import { test, expect, afterAll } from "bun:test";
import { isLight, themeOf } from "../public/themes.js";

/**
 * theme-apply.js 摸 DOM、localStorage 和网络，所以它没有被 themes.test.ts 覆盖。
 * 这里只验一件事：color-scheme 跟着主题的极性走。
 *
 * DOM 垫片必须把它替换掉的全局还回去——Bun 在一个进程里跑所有测试文件，
 * 覆盖 fetch 那次弄红过别的文件里 38 条测试。
 */
const saved = {
  document: (globalThis as { document?: unknown }).document,
  localStorage: (globalThis as { localStorage?: unknown }).localStorage,
  fetch: globalThis.fetch,
};
afterAll(() => {
  Object.assign(globalThis, saved);
});

test("color-scheme 跟着主题的极性走", async () => {
  const style = new Map<string, string>();
  Object.assign(globalThis, {
    document: {
      documentElement: {
        style: { setProperty: (k: string, v: string) => void style.set(k, v) },
        dataset: {} as Record<string, string>,
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const { applyTheme } = await import("../public/theme-apply.js");

  applyTheme("tokyo-night");
  expect(isLight(themeOf("tokyo-night"))).toBe(false);
  expect(style.get("color-scheme")).toBe("dark");

  applyTheme("catppuccin-latte");
  expect(isLight(themeOf("catppuccin-latte"))).toBe(true);
  expect(style.get("color-scheme")).toBe("light");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `~/.bun/bin/bun test src/theme-apply.test.ts`
Expected: FAIL，`expect(undefined).toBe("dark")` —— `applyTheme` 现在根本不写这个属性。

- [ ] **Step 3: 实现**

`public/theme-apply.js` 的 import 改成：

```js
import { themeVars, uiVars, themeOf, isLight, DEFAULT_THEME } from "./themes.js";
```

`applyTheme` 函数体在 `root.dataset.theme = name;` **之前**加：

```js
  // color-scheme 不能放进 uiVars：那里每个值都必须是 #rrggbb（有断言拦着），
  // 而这是个关键字。它决定原生滚动条、<select> 弹层、日期选择器的明暗——
  // 不写的话浅色主题下这些控件仍然是深色的。
  root.style.setProperty("color-scheme", isLight(themeOf(name)) ? "light" : "dark");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `~/.bun/bin/bun test src/theme-apply.test.ts`
Expected: PASS，两条断言都过。

- [ ] **Step 5: 删掉样式表里写死的那行**

`public/style.css` 的 `:root` 兜底块里删掉：

```css
  color-scheme: dark;
```

兜底块的其余部分保持 Tokyo Night 深色不动——它兜的是 `DEFAULT_THEME`，默认主题没变。脚本没跑起来时页面仍然渲染出正确的深色，只是原生控件回到浏览器默认，这比整页无样式好得多。

- [ ] **Step 6: 跑完整测试并提交**

```bash
~/.bun/bin/bun test src/theme-apply.test.ts src/themes.test.ts && ~/.bun/bin/bun run typecheck
git add public/theme-apply.js public/style.css src/theme-apply.test.ts
git commit -m "fix: color-scheme 跟着主题极性走，不再写死 dark"
```

---

### Task 6: 选择器分组与文案

**Files:**
- Modify: `public/themes.js`（`THEME_GROUPS` / `THEME_ORDER`）
- Modify: `public/settings.js`（`themeSection`）
- Modify: `public/i18n.js`（两个新 key，中英各一份）
- Test: `src/themes.test.ts`

**Interfaces:**
- Produces: `THEME_GROUPS: { labelKey: string, names: string[] }[]`；`THEME_ORDER` 由它推导，**形状不变**（仍是扁平字符串数组），所以现有消费者一个不动。

- [ ] **Step 1: 写失败的测试**

加在 `src/themes.test.ts` 的 `the picker order covers exactly the defined themes` 之后，import 里加上 `THEME_GROUPS`：

```ts
test("分组覆盖每一套主题，且没有重复", () => {
  const grouped = THEME_GROUPS.flatMap((g) => g.names);
  expect([...grouped].sort()).toEqual([...names].sort());
  expect(new Set(grouped).size).toBe(grouped.length);
});

test("每组的极性是一致的", () => {
  // 分组标题说的是"深色/浅色"，所以组里每一套都得真的是那个极性——
  // 排错了的话，选择器会在"浅色"标题下摆一套深色主题，而每条对比度断言都还是绿的。
  for (const group of THEME_GROUPS) {
    const want = group.labelKey === "settings.themeLight";
    for (const name of group.names) expect(isLight(THEMES[name]!)).toBe(want);
  }
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `~/.bun/bin/bun test src/themes.test.ts -t "分组"`
Expected: FAIL，`THEME_GROUPS` 未定义。

- [ ] **Step 3: 实现分组数据**

`public/themes.js` 里把 `THEME_ORDER` 那一段换成：

```js
/**
 * 选择器的顺序与分组。
 *
 * 深色四套、浅色三套——不对称是因为 Nord 没有官方浅色版（见 THEMES 里的注释）。
 * labelKey 是 i18n 的键而不是显示文本，跟插件清单里的 titleKey 是同一个做法。
 */
export const THEME_GROUPS = [
  { labelKey: "settings.themeDark", names: ["tokyo-night", "catppuccin-mocha", "one-dark", "nord"] },
  { labelKey: "settings.themeLight", names: ["tokyo-night-day", "catppuccin-latte", "one-light"] },
];

/**
 * 扁平的顺序，从分组推导。
 *
 * 保留这个导出而不是让调用方自己 flatMap：形状不变，themes.test.ts 和任何
 * 「遍历所有主题」的代码都不用动，分组只是多了一层结构。
 */
export const THEME_ORDER = THEME_GROUPS.flatMap((g) => g.names);
```

- [ ] **Step 4: 加文案**

`public/i18n.js` 中文字典里 `"settings.theme": "配色",` 之后加：

```js
  "settings.themeDark": "深色",
  "settings.themeLight": "浅色",
```

英文字典里 `"settings.theme": "Theme",` 之后加：

```js
  "settings.themeDark": "Dark",
  "settings.themeLight": "Light",
```

- [ ] **Step 5: 渲染分组**

`public/settings.js` 的 import 改成：

```js
import { THEMES, THEME_GROUPS, ANSI_NAMES } from "./themes.js";
```

`themeSection()` 里，把 `for (const name of THEME_ORDER) {` 改成两层循环。**注意**：原来的点击处理器遍历 `list.children` 来切换选中态，加了分组标题之后标题也是 `list` 的子节点，会被当成选项处理——改为按类名查询：

```js
  for (const group of THEME_GROUPS) {
    list.append(el("h3", "theme-group", tr(group.labelKey)));
    for (const name of group.names) {
```

（原来循环体整体缩进一级，末尾的 `list.append(row);` 之后补一个 `}` 收掉外层。）

同一个函数里，把

```js
      for (const other of list.children) {
```

改成

```js
      for (const other of list.querySelectorAll(".theme-opt")) {
```

- [ ] **Step 6: 加分组标题的样式**

`public/style.css` 里 `.theme-list` 相关规则附近加（**只能用主题变量，不许出现颜色字面量**）：

```css
.theme-group {
  margin: 12px 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

.theme-group:first-child { margin-top: 0; }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `~/.bun/bin/bun test src/themes.test.ts src/i18n.test.ts src/public-parses.test.ts`
Expected: PASS。`i18n.test.ts` 会确认两个新 key 中英都在、且都被用到；`public-parses.test.ts` 会确认 `settings.js` 改完还能被 `Bun.build` 解析。

- [ ] **Step 8: 提交**

```bash
~/.bun/bin/bun run typecheck
git add public/themes.js public/settings.js public/i18n.js public/style.css src/themes.test.ts
git commit -m "feat: 主题选择器分深色/浅色两组"
```

---

### Task 7: 文档

三处散文说「四套主题」，现在是七套。

**Files:**
- Modify: `CLAUDE.md`（**Colour themes** 一段）
- Modify: `README.md`、`README.zh-CN.md`（主题那一行）

- [ ] **Step 1: 改 CLAUDE.md**

**Colour themes** 那段开头的

```
**Colour themes**: every colour value lives in `public/themes.js` — four presets × the 23 `ITheme` fields — and nowhere else.
```

改成：

```
**Colour themes**: every colour value lives in `public/themes.js` — seven presets (four dark, three light) × the 23 `ITheme` fields — and nowhere else.
```

同一段末尾（`src/themes.test.ts` still enforces WCAG AA … 那句之后）加一段：

```
**Light themes are more presets, not a second axis.** `theme.json` still stores one name; nothing about persistence, `applyTheme` or `initTheme` changed. A theme's polarity is *computed* — `isLight(t)` is `luminance(background) > luminance(foreground)` — rather than declared, so a `dark: true` field can never disagree with the colours it describes. Everything in `uiVars()` that pushes a colour "until it clears the floor" takes its endpoint from that: `#ffffff` for a dark theme, `#000000` for a light one. Writing the endpoint as the theme's own `ansi[15]` is what the code used to do, and it fails in both directions — on a light theme the surfaces are already near white, so pushing toward white walks off the end of the loop and returns the endpoint itself (Latte's `--ok` and `--warn` both became `#bcc0cc`, 1.30:1 on a card); and even on a dark theme it is too weak for `--accent-hover`, because Catppuccin Mocha's bright white and its blue are only 1.057 apart. There is no Nord light: its Aurora colours land at 1.35–2.46:1 on a Snow Storm background, so a "Nord Light" would be a new palette wearing the name, with no upstream to check it against. The picker is deliberately asymmetric — four dark, three light — rather than inventing one.

**Raising a surface assumes the foreground has headroom, and one theme proved it.** `--surface-2..5` are the background mixed toward the *foreground*, so every step eats contrast that `--text-1` needs. The four dark themes hide this: their foregrounds are near-white, 8–11:1 on their own backgrounds. Tokyo Night Day's upstream foreground is a mid-tone blue at 4.52:1 — no headroom at all — and `--text-1` fell to 3.54:1 by `--surface-5` while `dimTo` could not move `--text-2` a single step. The fix is in the data (darken the foreground 18% to `#2d4f9d`), not in the surface ramp, because the ramp is what every other theme depends on. `%s: 表面层级单调远离底色` is the assertion that keeps the ramp honest in both polarities: "raised" means lighter on a dark theme and darker on a light one, and getting it backwards would leave every contrast assertion green while the `--surface-4` baseline they all measure against became the wrong end of the scale.
```

- [ ] **Step 2: 改两份 README**

`README.md` 有两处。表格那一行：

```
| **Colour themes** | Four presets (Tokyo Night, Catppuccin Mocha, One Dark, Nord), switched from the list header, applied without a reload |
```

改成：

```
| **Colour themes** | Seven presets — four dark (Tokyo Night, Catppuccin Mocha, One Dark, Nord) and three light (Tokyo Night Day, Catppuccin Latte, One Light) — switched from Settings, applied without a reload |
```

`### Colour themes` 一节的头一段：

```
Tap the gear in the list header. Four presets ship: Tokyo Night (default), Catppuccin Mocha, One Dark and Nord — each shown with its palette and a sample before you pick. The change applies immediately, no reload.
```

改成：

```
Tap the gear in the list header. Seven presets ship, in two groups: four dark — Tokyo Night (default), Catppuccin Mocha, One Dark, Nord — and three light — Tokyo Night Day, Catppuccin Latte, One Light. Each is shown with its palette and a sample before you pick, and the change applies immediately, no reload. There is no Nord light: Nord ships no upstream light variant, and inventing one would mean re-picking half its hues with nothing to check the result against.
```

同一节最后一段的 `the four presets do **not** use their upstream `brightBlack`` 那句保持不变——它讲的是那四套深色预设，仍然准确。

`README.zh-CN.md` 对应两处。表格那一行：

```
| **配色主题** | 四套预设（Tokyo Night / Catppuccin Mocha / One Dark / Nord），列表顶栏切换，无需刷新 |
```

改成：

```
| **配色主题** | 七套预设，深色四套（Tokyo Night / Catppuccin Mocha / One Dark / Nord）、浅色三套（Tokyo Night Day / Catppuccin Latte / One Light），设置页切换，无需刷新 |
```

`### 配色主题` 一节的头一段：

```
点列表顶栏的齿轮。内置四套：Tokyo Night（默认）、Catppuccin Mocha、One Dark、Nord——每套都带色板和一段样例，选之前就知道长什么样。点了立刻生效，不用刷新。
```

改成：

```
点列表顶栏的齿轮。内置七套，分两组：深色四套——Tokyo Night（默认）、Catppuccin Mocha、One Dark、Nord；浅色三套——Tokyo Night Day、Catppuccin Latte、One Light。每套都带色板和一段样例，选之前就知道长什么样，点了立刻生效，不用刷新。没有 Nord 浅色版：Nord 没有官方浅色配色，自己造一套意味着重挑一半色相，而且没有任何上游可以拿来对照。
```

同一节最后一段讲 `brightBlack` 的那句保持不变，它说的是那四套深色预设，仍然准确。

- [ ] **Step 3: 确认没有别处还在说「四套」**

Run: `grep -rn "four preset\|四套主题\|Four presets" README.md README.zh-CN.md CLAUDE.md docs/`
Expected: 只剩规格与本计划里那些**在讲历史**的句子（「四套深色主题」是准确的），没有把主题总数说成四的地方。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md README.zh-CN.md
git commit -m "docs: 主题从四套变七套"
```

---

## 收尾

- [ ] **跑一次完整测试**

Run: `~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test`

Expected: `themes.test.ts`、`theme-apply.test.ts`、`i18n.test.ts`、`public-parses.test.ts` 全绿。

**注意**：整套测试有一条已知的、稳定的 9 失败 / 1 错误的尾巴，跟本次改动无关——某个测试用 `-c` 指向临时目录建过会话，tmux **服务器**把那个路径记成了自己的工作目录，目录被删之后所有新建的 pane 都继承了一个不存在的 cwd。详见 CLAUDE.md。**不要为了它重跑，更不要 `tmux kill-server`。** 判断标准是本次改动涉及的四个测试文件是否全绿，以及失败数是否仍是那个已知的尾巴。

- [ ] **人眼看一遍**

Run: `~/.bun/bin/bun run src/index.ts`，浏览器开 `http://127.0.0.1:7682/`，进设置页逐个点这七套主题。要确认的：

1. 三套浅色下卡片、chip、按钮文字都读得清，「结束会话」的红仍然是红的。
2. 悬停在主动作按钮上有可见的颜色变化——**深色主题下也要有**，那是这次修的 bug。
3. 浅色主题下滚动条和 `<select>` 弹层是浅色的（`color-scheme` 生效）。
4. 终端页在浅色主题下整体是浅色的，xterm 里的输出读得清。

**注意**：`public/` 是每次请求现读磁盘的，`src/` 只在启动时加载一次。所以改完前端刷新即可，改完后端必须重启进程——一个跑着的服务经常是一半新一半旧。
