# 响应式：让同一份页面在桌面上也成立

2026-09-02

## 问题

这个前端从第一天起只有手机版。`public/style.css` 一千七百多行、加上两个插件样式表，**一个宽度断点都没有**——三处 `@media` 全是 `prefers-reduced-motion`。所有布局都是单列铺满，配上 `env(safe-area-inset-*)`、`-webkit-overflow-scrolling`、`user-scalable=no`、44px 触控靶，整套是刘海屏假设。

在 1440px 的窗口里，这套假设的后果是具体的：

- 一张卡片的名字后面拖着一米空白，一屏只装得下四五张单
- 工具条（同步 / 显示已归档 / 分组 / 筛选）纵向堆成四行，只用掉左边五分之一的宽度
- 底部 sheet 变成横贯全屏的一条，`max-width: 520px` 让它居中，但圆角只在上边、下边贴着屏幕底缘——一个从下缘长出来的东西在桌面上没有语义
- 终端页那排 Esc / Tab / ↑↓ 在有物理键盘时纯属占据高度，而同一排里的图片上传、粘贴、字号加减在桌面上仍然有用，所以不能整条藏掉
- 全站只有 `:active` 没有 `:hover`——鼠标划过任何按钮都毫无反馈

## 不做什么

不做 UA 嗅探，不做第二套页面，不做 `desktop.html`。一份 DOM、一套样式表、若干断点。两套页面意味着每个功能改两遍，而这个仓库已经有过"三个 header 各抄一份然后漂移"的教训（见 `nav.js` 的开头注释）。

本阶段**不做**左列表 / 右终端的双栏形态。那要求 `terminal.js` 从"独占一页的脚本"改成"可挂载到给定容器"——它现在读 `location.search`、写 `document.title`、绑全局键盘、假设自己拥有整个视口。那是运行时逻辑的重构，风险和这次纯排版的改动不是一个量级，留给后续独立的一轮。本文末尾记下它，不承诺时间。

## 一、两个正交的判断

最容易做错的是把"桌面"当成一个开关。它其实是两件互不蕴含的事：

| 判断 | 查询 | 决定 |
| --- | --- | --- |
| 宽不宽 | `@media (min-width: 900px)` | 布局：几列、内容列宽、sheet 从下缘弹还是居中弹 |
| 有没有精确指针 | `@media (hover: hover) and (pointer: fine)` | 交互：hover 态、终端软键盘条的默认展开状态 |

它们必须分开，因为反例两边都存在：

- **iPad 横屏是宽的，但没有鼠标。** 把软键盘条绑在宽度上，iPad 横屏就失去 Esc / Tab / 方向键——而那正是最需要它们的设备。
- **窄窗口的 Mac 有鼠标，但不宽。** 把 hover 态绑在宽度上，把窗口拖窄一半，鼠标反馈就没了。

第三层已经存在，不动：`terminal-fit.js` 里的 `MAX_FONT_PX` 早就有手机 / 桌面两个 regime（"字号涨到 12px 封顶，剩下的宽度买列数"），并且它的分界点是算出来的而不是嗅探出来的——那正是本设计想遵循的同一条原则，所以它保持原样。

## 二、断点只有一个值，并且有测试盯着

原生 CSS 的 `@media` 里用不了自定义属性，所以 `900px` 这个字面量会散落在内核样式表和每个插件样式表里，没有任何机制阻止第二个人写 `768px`、第三个人写 `1024px`。三个文件在三个不同宽度换布局，这种 bug 只在某个特定窗口宽度现形，靠看代码发现不了。

仓库里已有对付这类问题的成法：`src/themes.test.ts` 扫所有样式表里的颜色字面量，并带一份"已存在的例外"清单，让新债咬人而旧债保持可见且有限。照抄它：

**`src/responsive.test.ts`** 扫 `public/style.css` 与 `plugins/*/public/style.css`，断言：

1. 每一处 `@media` 里的 `min-width` / `max-width` 取值 ∈ `{ 900px }`
2. 每一处指针相关的媒体查询写作 `(hover: hover) and (pointer: fine)`，不接受单独的 `hover: hover`（Windows 上带触摸屏的笔记本两者都报 true，只查 hover 会把它误判成纯鼠标设备）

断点值本身导出成模块常量供测试引用，避免测试和样式表各写一遍 900。

## 三、逐项改动

以下全部是样式表 + 少量类名，**不改任何运行时逻辑**。

### 3.1 列表页：内容列 + 卡片网格

`index.html`（单）和 `sessions.html`（会话）结构相同：`main` 里先是工具条，然后要么直接是卡片，要么是若干 `<section>`，每个 section 里一个 `h2` 分组标题加若干卡片。

宽屏下：

- `main` 给 `max-width: 1200px; margin-inline: auto`——不是铺满。一行文本超过 ~90 个字符就难读了，卡片标题铺满 1440px 只会让眼睛在行末找不到下一行的行首
- 卡片容器（`main` 自身，以及每个 `section`）改 `display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px`
- `.card` 现在的 `margin: 0 12px 12px` 在网格里会和 gap 叠加成不均匀的沟，宽屏下清零，间距交给 gap
- `.toolbar` 与 `.group-name` 设 `grid-column: 1 / -1` 横跨整行——否则标题会变成网格里的一个格子，坐在第一张卡片旁边
- `.toolbar` 从 `flex-direction: column` 改回 `row`，四组控件一行排开

`auto-fill` + `minmax` 而不是写死列数：这样 900px 得到两列、1440px 三列、超宽屏四列，不需要为每一档再加断点。`340px` 是下限——卡片里有单标题、facet chips、会话行，再窄就开始逐个截断了。

### 3.2 sheet：宽屏改居中卡片

`.sheet-backdrop` 现在是 `align-items: flex-end`。宽屏下改 `center`，`.sheet` 的圆角从 `16px 16px 0 0` 改成四角全圆，底部 padding 里的 `env(safe-area-inset-bottom)` 归零，`max-height` 从 `calc(100dvh - safe-area-top)` 改成 `min(80dvh, 640px)`。

注意 `.sheet` 在样式表里**定义了两次**（约 938 行和约 1619 行，后者胜出，两份的 `max-width` 和圆角都不一样）。这是既有的债，本次不重构它，但两处都要给到宽屏覆盖，否则会出现"确认框居中了、明细浮层还贴着底"的分裂。修完在两处各留一行注释指向对方。

`body.sheet-open` 那套锁滚动的机制照旧：桌面上滚轮同样会穿透到背后的页面。

### 3.3 终端页：软键盘条一行摊开

`.keys-more { display: none }` / `.keys.expanded .keys-more { display: flex }` 现在靠 JS 加的 `.expanded` 类切换。

在 `(hover: hover) and (pointer: fine)` 下，纯 CSS 覆盖成 `.keys-more { display: flex }`（永远展开）并把 `#keys-toggle` 设为 `display: none`。效果是：有物理键盘时三行按钮全部可见、不需要点开，展开箭头消失。JS 那边继续加减 `.expanded` 类，视觉上是空操作——**不改 JS**，也就不会有 `aria-expanded` 说一套、屏幕显示另一套的问题，因为那个按钮已经不在了。

为什么不干脆整条藏掉：里面的图片上传、文件上传、粘贴、复制、字号加减在桌面上一样有用，Esc / Tab / 方向键才是物理键盘替代得了的。藏掉一半留一半需要 JS 判断，那就越过了本阶段的边界。

再进一步，宽屏时把三行合并成一行居中（`flex-direction: row; flex-wrap: wrap; justify-content: center`），并给 `.keys button` 去掉 `flex: 1 1 auto`——按钮平分一整个桌面宽度会变成一排巨大的色块。

### 3.4 hover 态

`(hover: hover) and (pointer: fine)` 下，给现有每一处 `:active` 规则配一个对应的 `:hover`：`.card-main`、`.more`、`.keys button`、`header .hbell`、`.btn`、`.copy-link`、`.restore-row`、`.term-back`、`.term-kill` / `.term-rename`、插件样式表里的同类。颜色仍然只能来自主题变量——`color-mix` 从 `--card` / `--raised` 派生，跟 `--raised` 自己的做法一致，绝不新增颜色字面量（`src/themes.test.ts` 会拦）。

同时给这些元素补 `cursor: pointer`：现在只有 `.restore-row`、`.key-tile`、`.clear-filter` 三处有，鼠标划过一张卡片时光标是箭头，看不出能点。

### 3.5 固钉元素避让

- `.ver`（右下角构建号）：保持 `position: fixed`，宽屏下把 `right` 从 8px 改成对齐内容列的右边缘（`max(8px, calc((100% - 1200px) / 2 + 8px))`）。不改成随内容流动，是因为它在窄屏上就是个不参与布局的角标，让它在两种宽度下换两种定位方式，等于给一个装饰元素两套行为
- `header`：宽屏下 `position: sticky; top: 0`，加上背景色和一道下边框——桌面窗口高，滚下去之后没有任何东西能切回另一个标签页

### 3.6 插件页

`plugins/jira/public/style.css`（602 行）与 `plugins/gallery/public/style.css`（139 行）各自加宽屏规则，用同一个断点常量。画廊的缩略图网格本来就该在宽屏多列；Jira 的 issue 列表套用 3.1 同一套内容列 + 网格。插件样式表由插件自己拥有（见 CLAUDE.md），不把它们的规则搬进内核样式表。

## 四、测试

CLAUDE.md 立的规矩是"会渲染的浏览器模块必须有渲染它的测试"。本次不新增浏览器模块，也不改任何渲染逻辑，所以不需要新的 happy-dom 页面测试。要新增的是守住这次引入的**结构性约束**的测试：

**`src/responsive.test.ts`**（新增）

1. 断点唯一性：所有样式表里的 `min-width` / `max-width` 取值只能是 900px（见 §2）
2. 指针查询的写法必须带 `pointer: fine`（见 §2）
断点的允许集合就写在这个测试文件里，不新建模块：CSS 读不到 TypeScript 常量，多一个模块也换不来单一事实来源，只是多一个要同步的地方。

**回归**：`src/themes.test.ts`（颜色字面量）和 `src/public-parses.test.ts`（`Bun.build` 能过）必须继续通过。样式表不经过 `Bun.build`，所以后者不会覆盖到这次改动，这是已知的空隙，不在本次填补。

**手工验证清单**（写进实现计划，不进自动化）：390px（iPhone）、834px（iPad 竖）、1180px（iPad 横，宽但无鼠标——软键盘条必须还在）、1440px（桌面）四档，每档过一遍：单列表、会话列表、终端页、新建页、Jira 页、画廊页。

## 五、留给后续：双栏

参考形态是 Tembo（`app.tembo.io`）：左侧栏常驻会话列表（可置顶、可搜、宽度记忆），中间工作区，右侧栏是详情（PR 检查、操作、文件树）。映射到本项目就是左边单/会话列表、中间终端、右边 facet 与 PR 明细。

前置条件是 `terminal.js` 能被挂载到一个给定容器而不是独占页面。具体要拆开的耦合：

- `const target = new URLSearchParams(location.search).get("target")` —— 目标会话应当由调用方传入
- `document.title = target` —— 页面标题不该由一个可能只占半屏的组件写
- 全局键盘绑定与 `--app-height`（跟随视觉视口的软键盘补偿）—— 双栏下这两个的作用域都要收窄到容器
- `back-target.js` 那套返回逻辑在双栏里没有意义（不跳页就没有"返回"）

这些都不是本阶段的工作，记在这里是为了下一轮不用重新勘察。

## 影响面

改动文件：`public/style.css`、`plugins/jira/public/style.css`、`plugins/gallery/public/style.css`，新增 `src/responsive.test.ts`。不改任何 `.js`、不改任何 `.ts` 运行时代码、不改任何 HTML 结构。

窄屏行为逐像素不变：所有新规则都在 `min-width` / `hover` 查询里，手机上一条都不生效。
