// @ts-check
/**
 * 够用的 Markdown 解析。
 *
 * 解析成一棵普通对象的树，不碰 DOM——建节点那一步在页面里，很薄。这么分是为了
 * 能无头地测：这个仓库没有构建步骤也没有运行时依赖，渲染器只能自己写，而自己写
 * 的解析器如果不能测，就是在往会话内容上押运气。
 *
 * **绝不产出 HTML 字符串。** 这段文字来自会话内容，最终一律经 `textContent` 落地；
 * 解析器的输出是数据，不是标记，所以注入这条路从形状上就不存在。
 *
 * 覆盖的是 Claude 实际会写的那些：标题、粗体、斜体、行内代码、围栏代码块、有序与
 * 无序列表、引用、链接、水平线、表格。
 */

/**
 * @typedef {{ type: "text" | "code" | "strong" | "em", value: string }
 *   | { type: "link", value: string, href: string }} Span
 * @typedef {{ type: "p" | "quote", spans: Span[] }
 *   | { type: "h", level: number, spans: Span[] }
 *   | { type: "code", value: string, lang: string }
 *   | { type: "list", ordered: boolean, items: Span[][] }
 *   | { type: "table", head: Span[][], rows: Span[][][], align: Align[] }
 *   | { type: "hr" }} Block
 * @typedef {"left" | "center" | "right"} Align
 */

/** 只放行 http/https：`javascript:` 之类不该因为一段会话内容就变成可点的东西。 */
function safeHref(/** @type {string} */ href) {
  return /^https?:\/\//i.test(href.trim()) ? href.trim() : "";
}

/**
 * 一行文字里的行内标记。
 *
 * 行内代码先切：它里面的 `*` 和 `[` 不该再被当成标记，这是最常见的一处错解。
 */
export function parseInline(/** @type {string} */ text) {
  /** @type {Span[]} */
  const spans = [];
  // 顺序有意义：代码在最前，链接在强调之前（链接文字里可以有强调，反过来不行）。
  const pattern = /(`[^`]+`)|(\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/;

  let rest = text;
  while (rest) {
    const m = pattern.exec(rest);
    if (!m || m.index === undefined) break;

    if (m.index > 0) spans.push({ type: "text", value: rest.slice(0, m.index) });
    const token = m[0];

    if (token.startsWith("`")) {
      spans.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const cut = token.indexOf("](");
      const label = token.slice(1, cut);
      const href = safeHref(token.slice(cut + 2, -1));
      // 地址不合规就退回纯文字：一个点了没反应、或者更糟的链接，不如不做成链接。
      spans.push(href ? { type: "link", value: label || href, href } : { type: "text", value: token });
    } else if (token.startsWith("**")) {
      spans.push({ type: "strong", value: token.slice(2, -2) });
    } else {
      spans.push({ type: "em", value: token.slice(1, -1) });
    }
    rest = rest.slice(m.index + token.length);
  }

  if (rest) spans.push({ type: "text", value: rest });
  return spans;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;

/**
 * `|---|:--:|---:|` 这一行——它才是「上一行是表头」的凭据。
 *
 * 一个横杠就算数（`|:-:|` 是合法的），但整行必须含竖线：否则光秃秃一行 `-` 跟在
 * 任何带竖线的句子后面，都会被误认成表格。
 */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableRule(/** @type {string} */ line) {
  return line.includes("|") && TABLE_RULE.test(line);
}

/**
 * 一行 `| a | b |` 切成单元格。
 *
 * 首尾的竖线是可选的，所以切完要把两端的空壳去掉——但只去一个，不然 `| | b |`
 * 里那个真的空单元格也会被吃掉。
 */
function cellsOf(/** @type {string} */ line) {
  const parts = line.split("|");
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.length && parts[parts.length - 1]?.trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

/** 分隔行里的冒号决定对齐。 */
function alignOf(/** @type {string} */ line) {
  return cellsOf(line).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

/**
 * 一段 Markdown 的块结构。
 *
 * 逐行走，因为围栏代码块必须整块吞掉——在它里面，`#` 和 `-` 都只是代码。
 *
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  /** @type {Block[]} */
  const blocks = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");

  /** @type {string[]} */
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: "p", spans: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // 围栏代码：整块原样收走，里面什么都不解析。
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const lang = (fence[1] ?? "").trim();
      /** @type {string[]} */
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ type: "code", value: body.join("\n"), lang });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: "hr" });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: "h", level: (heading[1] ?? "#").length, spans: parseInline(heading[2] ?? "") });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      blocks.push({ type: "quote", spans: parseInline(quote[1] ?? "") });
      continue;
    }

    // 表格：靠下一行那条分隔线认，不靠「这行有竖线」——正文里带竖线的句子太常见了。
    if (line.includes("|") && isTableRule(lines[i + 1] ?? "")) {
      flushPara();
      const head = cellsOf(line).map(parseInline);
      const align = alignOf(lines[i + 1] ?? "");
      /** @type {Span[][][]} */
      const rows = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        const cells = cellsOf(lines[i] ?? "");
        // 补齐到表头宽度：少一格的行如果原样画出来，整张表会错位。
        while (cells.length < head.length) cells.push("");
        rows.push(cells.slice(0, head.length).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ type: "table", head, rows, align });
      continue;
    }

    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    if (bullet || number) {
      flushPara();
      const ordered = !!number;
      /** @type {Span[][]} */
      const items = [];
      // 连续同类的行归成一个列表；换成另一种就重开一个。
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const b = BULLET.exec(current);
        const n = NUMBER.exec(current);
        if (ordered ? !n : !b) break;
        items.push(parseInline((ordered ? n?.[1] : b?.[1]) ?? ""));
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    para.push(line.trim());
  }

  flushPara();
  return blocks;
}
