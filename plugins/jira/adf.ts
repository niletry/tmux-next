/**
 * Jira 的富文本（Atlassian Document Format）→ 纯文本。
 *
 * 描述正文要被塞进一个终端里的输入框，所以要的就是纯文本，不是保真的转换：这里只认
 * 段落、列表和换行，别的一律当容器往下走。认不出的输入返回空串而不是抛——fields 整条
 * 路的失败语义是"拿不到就当没有"，一个格式没见过的描述不该让整张模板渲染不出来。
 *
 * 迭代而不是递归：描述是别人写的，嵌套深度没有上限，而爆栈会变成一个 500。
 */
/**
 * 每种容器把自己的子节点结果拼起来用的分隔符——块级容器（doc、列表）之间空一行
 * 或换一行，行内容器（paragraph、heading）里的子节点直接连写，不额外插空。
 * 没登记的类型按行内处理，容器语义不明时"少插一个换行"比"多插一个"更安全。
 */
const BLOCK_SEP: Record<string, string> = {
  doc: "\n\n",
  bulletList: "\n",
  orderedList: "\n",
  listItem: "\n\n",
};

export function adfToText(node: unknown): string {
  // 老实例的描述可能直接是一段字符串（wiki 标记），原样用。
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";

  /**
   * 栈里放的是"正在拼这个节点的子节点结果"这件事本身，不是节点自己——分隔符
   * 由**父节点的类型**决定（段落里的两个文本节点不该被列表的换行分开），所以
   * 拼接必须在子节点全部处理完、回到父节点时才做一次，这也是不能用简单的
   * 前序压栈+拼字符串来处理的原因。用显式栈存半成品结果，而不是递归函数调用，
   * 是为了不让嵌套深度撞上 JS 的调用栈——描述是别人写的，嵌套深度没有上限。
   */
  type Frame = { type: string; children: unknown[]; idx: number; parts: string[] };
  const makeFrame = (n: Record<string, unknown>): Frame => ({
    type: typeof n.type === "string" ? n.type : "",
    children: Array.isArray(n.content) ? n.content : [],
    idx: 0,
    parts: [],
  });

  const stack: Frame[] = [makeFrame(node as Record<string, unknown>)];
  const attach = (text: string) => {
    if (!text) return;
    stack[stack.length - 1]!.parts.push(text);
  };

  let finalText = "";
  while (stack.length) {
    const frame = stack[stack.length - 1]!;

    if (frame.idx < frame.children.length) {
      const child = frame.children[frame.idx++];
      if (!child || typeof child !== "object") continue; // 认不出的子节点直接跳过
      const c = child as Record<string, unknown>;
      if (c.type === "text" && typeof c.text === "string") {
        attach(c.text);
      } else if (c.type === "hardBreak") {
        attach("\n");
      } else {
        stack.push(makeFrame(c)); // 别的一律当容器往下走
      }
      continue;
    }

    // 这个节点的子节点都处理完了，拼成它自己的文本，交给父节点。
    stack.pop();
    let text = frame.parts.filter(Boolean).join(BLOCK_SEP[frame.type] ?? "");
    if (frame.type === "listItem") text = "- " + text; // 列表项前面加短横
    if (stack.length) attach(text);
    else finalText = text;
  }

  // 整体两头不留空白；意外堆出三个以上换行时压回一行空行，不是靠它撑起主要格式。
  return finalText.replace(/\n{3,}/g, "\n\n").trim();
}
