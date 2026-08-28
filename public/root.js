// @ts-check
/**
 * 应用根，以及按它解析路径。
 *
 * 全站的 URL 都是相对的，为的是能挂在反代的子路径下——绝对路径会把这个能力
 * 弄断。但相对 URL 是按**页面**解析的，而插件页面在 /p/<id>/ 下：共享模块里
 * 一句 fetch("api/language") 从列表页打到 /api/language，从制品页打到
 * /p/gallery/api/language。
 *
 * 所以根从这个模块自己的 URL 推——它永远在根上，且它在哪个前缀下被服务，推出
 * 来的根就在哪个前缀下。两个性质都要，缺一不可。
 */

/** 纯粹的一层，好在 src/root-url.test.ts 里不带 DOM 地测。 */
export function resolve(/** @type {string} */ base, /** @type {string} */ path) {
  return new URL(path, base).href;
}

const ROOT = import.meta.url;

/** 把一个根相对的路径解析成能用的 URL。 */
export function url(/** @type {string} */ path) {
  return resolve(ROOT, path);
}
