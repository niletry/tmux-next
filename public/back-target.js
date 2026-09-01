// @ts-check
/**
 * 终端页那个返回箭头该指回哪里。
 *
 * 它原来是写死的 `href="./"`：无论你从哪儿点进一个会话，返回都把你扔回会话列表。
 * 从工单页进去的人因此每次都要重新找回那条工单——列表页并不是所有人的来路。
 *
 * 所以开会话的链接上带一个来路标记（`from=<id>`），这里把它翻译成一个地址。
 * 标记是 id 而不是路径：路径来自 URL，等于让任何人往返回键上塞任意地址，而 id
 * 只能落在一张已知的表里，认不出来就退回会话列表。
 *
 * 那张表不是内核里按插件名写死的映射——调用方从 plugins/registry.js 推出它来，
 * 跟顶栏的标签是同一份数据。这里只做匹配，不认识任何具体插件。
 */

/**
 * @typedef {{ id: string, path: string, titleKey: string }} BackPage
 * 一个可能的来路：id 是链接上写的标记，path 是相对应用根的地址。
 */

/**
 * 来路那一页当时的视图状态（`fq=`），重新拼成一段 query。
 *
 * 解析再重建，而不是把它当字符串接上去：这样任何不是 query 的东西——协议、`//`
 * 开头的主机名——都只会变成一个键名被编码掉，拼出来的地址永远还在表里那个路径下。
 *
 * @param {string | null} fq
 * @returns {string}
 */
function queryOf(fq) {
  if (!fq) return "";
  const rebuilt = new URLSearchParams(fq).toString();
  return rebuilt ? `?${rebuilt}` : "";
}

/**
 * @param {string} search 终端页的 location.search
 * @param {BackPage[]} pages 认得的来路，第一项是缺省的那个
 * @returns {BackPage}
 */
export function backTarget(search, pages) {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const page = from ? pages.find((p) => p.id === from) : undefined;
  // 认不出来路就退回缺省页，那段视图状态也一并丢掉：它是给来路那一页的，挂在别
  // 的页面上只会是一段没人读的参数。
  if (!page) return pages[0];
  return { ...page, path: page.path + queryOf(params.get("fq")) };
}
