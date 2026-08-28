# 插件接缝：把制品库和通知页从内核里拔出来

## 问题

制品库现在是硬连进去的一块，摊在四个地方：`src/gallery.ts` 的存储与路径安全、`src/server.ts` 里三段路由、`public/gallery.{html,js}` 的页面、`public/nav.js` 里写死的第二个 tab，外加 `public/i18n.js` 中间那 17 个 `gallery.*` 键。通知页是同样的形状。

代价不是"文件多"，是**没有边界**：想去掉制品库要在五个文件里做减法，而且删不干净；想加第三个页面（日志、监控、随便什么）要重复同一套散落的接线，还得改 `nav.js` 里一张写死的数组。

要的是一条接缝：一个页面级功能能整个装进一个目录，加它等于加目录、删它等于删目录。

## 不做什么

- **不做运行时动态加载。** 不扫 `~/.tmux-next/plugins/` 做 dynamic import。那等于在一个无认证的 loopback 服务里跑任意第三方代码，还要为此造隔离和错误边界，而现在没有第三方插件生态需要伺候。插件是仓库内置的，注册表写死；别人要加插件就发 PR 或 fork。
- **不做中间件链。** 让插件导出 `fetch(req)` 依次询问更自由，但路由归属就变成运行时才知道的事——出问题时说不清是谁劫持了请求。现在的路由是一条可读的 `if` 链，可枚举性比自由度值钱。
- **会话页不做成插件。** 它是内核。把它插件化只会多一层间接，换不来任何东西。
- **不做终端页挂钩、WebSocket 扩展、后台任务。** 这两个插件都用不上，属于提前造。

## 接口

一个插件是 `plugins/<id>/` 一个目录：

```
plugins/
  registry.js          同构清单数组（浏览器 + 服务端都 import）
  handlers.ts          id → 服务端 handle 的表 + enabledPlugins()（只有服务端 import）
  types.ts             Plugin / PluginHandler 类型
  state.ts             pluginStateDir(id)
  gallery/
    plugin.js          清单
    server.ts          handle(req, url)
    gallery.ts         由 src/gallery.ts 搬来
    gallery.test.ts    跟着搬
    public/index.html
    public/gallery.js
  notifications/
    plugin.js
    server.ts
    public/index.html
    public/notifications.js
```

### 清单（`plugin.js`）

`@ts-check` + JSDoc，跟 `public/` 里其他模块一致。纯数据，没有行为：

```js
export default {
  id: "gallery",                      // 决定 /api/gallery/*、/p/gallery/*、状态目录名
  titleKey: "gallery.title",          // 顶栏 title/aria-label
  icon: '<rect x="3" y="3" .../>',    // 24×24 viewBox 的 path 串，格式同 nav.js 现有图标
  i18n: { zh: { ... }, en: { ... } },
};
```

`id` 必须匹配 `^[a-z][a-z0-9-]*$`，全仓唯一。

### 清单和 handler 必须分成两张表

这是最容易踩的一脚。`registry.js` 被浏览器 import，而 `public-parses.test.ts` 用 `Bun.build` 解析它的整张 import 图。清单里只要引到 `server.ts`，服务端代码就被拖进浏览器包——所以服务端 handler 单独放 `handlers.ts`，浏览器永远碰不到它。

`registry.test.ts` 里有一条断言专门守这个：registry.js 的 import 图不含任何 `.ts`。

### 服务端 handler（`server.ts`）

```ts
export function handle(req: Request, url: URL): Promise<Response | null>;
```

只在路径命中 `/api/<id>` 或 `/api/<id>/*` 时被调用（前缀由内核校验）。返回 `null` 表示"这个子路径我不认"，内核继续往下走到 404。

## 内核改动

### 路由分发

`src/server.ts` 里现有的 gallery 三段和 notifications 一段删掉，换成一段循环，位置在核心路由之后、静态资源之前：

```ts
for (const p of enabledPlugins()) {
  if (url.pathname === `/api/${p.id}` || url.pathname.startsWith(`/api/${p.id}/`)) {
    const res = await HANDLERS[p.id]!(req, url);
    if (res) return res;
  }
}
```

### 静态资源

`/p/<id>/<file>` → `plugins/<id>/public/<file>`；`/p/<id>/` 给 `index.html`。文件名走跟 `safeGalleryName` 同样的 basename 收窄——插件目录同样不能被 `..` 爬出去。禁用的插件，API 和静态资源一起消失。

用 `/p/<id>/` 而不是 `/<id>/`：一级路径迟早跟 `public/` 里的文件或未来的 API 撞名。

### 旧地址

`/gallery.html` 和 `/notifications.html` 保留 301 到 `p/gallery/`、`p/notifications/`。手机上存了书签、装了 PWA 的人不该撞 404。

### 开关

`TMUX_NEXT_DISABLE_PLUGINS=gallery,notifications`（逗号分隔），默认全开。

`enabledPlugins()` 放在 `handlers.ts` 而不是 `registry.js`：读 env 是服务端的事，浏览器里没有 `process.env`，把它放进同构模块等于埋一个只在浏览器炸的调用。前端要知道启用了什么，走下面的 `/api/plugins`。

### `/api/plugins`

`GET` 返回启用的 id 数组。给前端渲染顶栏用。

## 前端改动

### 顶栏

`nav.js` 的 `TABS`：`sessions` 仍然写死（内核），其余从 registry 生成，`href` 用相对的 `p/<id>/`。

全站现在都用相对路径，为的是能挂在反代子路径下；绝对路径会把这个能力弄断。插件页面 import 共享模块因此写 `../../i18n-apply.js`、`../../nav.js`——浏览器会规范化到根。丑一点，但保住子路径部署。

`renderHeader` 本来就是 async，多拉一次 `/api/plugins` 取启用列表。**失败时回退成"registry 里的全部"**：默认就是全开，离线或服务暂时不可达不该让两个 tab 莫名消失。

### i18n

`public/i18n.js` 末尾把插件字典合并进 `zh` / `en`。

**合并全部插件，不按启用过滤。** 禁用一个插件不该让它的文案在 `i18n.test.ts` 里变成"缺失键"——那个测试的价值恰恰在于它是全量的。

## 通知日志的边界

`~/.tmux-next/notifications.jsonl` 是**推送管线写的**（`/api/notify` → `src/push.ts`），通知页只是读它。

所以 `src/notifications.ts` 留在内核，不搬进插件。否则内核要反向依赖插件才能记一条日志，接缝就白划了。

通知插件拥有的是：页面、前端脚本、`GET /api/notifications` 这条读路由。**插件被禁用时推送照常工作**，只是网页上翻不到历史。

## 状态目录

```ts
pluginStateDir(id) = process.env[`TMUX_NEXT_${ID}_DIR`] ?? join(homedir(), ".tmux-next", id)
```

路径在函数里惰性读取，不在模块加载时捕获——跟仓库里其他状态路径的规矩一样，测试才能先设 env 再调用。

制品库正好命中现有的 `TMUX_NEXT_GALLERY_DIR` 和 `~/.tmux-next/gallery`：**零迁移，`tmux-next-gallery` skill 一个字都不用改**。通知插件不用它（日志归内核）。

## 测试

| 文件 | 覆盖什么 |
|---|---|
| `plugins/registry.test.ts` | id 唯一、匹配 `^[a-z][a-z0-9-]*$`、字段齐全、两语言键集一致、**import 图不含 `.ts`** |
| `src/plugin-routing.test.ts` | 启用时 `/api/gallery` 和 `/p/gallery/` 通；禁用后双双 404；`/p/gallery/../../src/server.ts` 被拒；旧地址 301 |
| `src/i18n.test.ts` | 扫描目录加上 `plugins/*/public/*.{js,html}` 和 `plugins/*/plugin.js` |
| `src/public-parses.test.ts` | 同上，插件的 public 也要过 `Bun.build` |
| `plugins/gallery/gallery.test.ts` | 由 `src/gallery.test.ts` 搬来，内容不变 |

两个扫描型测试必须跟着扩：它们存在的理由是"这些文件只有浏览器加载，语法错误会静悄悄发布"，插件的 public 目录一字不差地符合这个描述。

## 落地顺序

1. 立接口：`types.ts`、`registry.js`、`handlers.ts`、`state.ts`，加 `/api/plugins` 和 `/p/<id>/*` 静态映射，加 `registry.test.ts` 和 `plugin-routing.test.ts`
2. 搬制品库
3. 搬通知页
4. 删 `server.ts` 里的旧路由块，加 301
5. 扩两个扫描型测试
6. 更新 `CLAUDE.md` 架构一节、`README.md` 与 `README.zh-CN.md`

每一步跑 `bun run test`。第 2 步之后制品库应当行为完全不变——同样的 URL 之外的一切（磁盘目录、上传上限、渲染）都不动。
