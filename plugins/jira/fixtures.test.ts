import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * 这个仓库是公开的，历史被清洗过一次——工单号、公司名、主机名、真实路径都被从
 * 全历史里拿掉过。一个对着真实 Jira 写的夹具会把它们又带回来。
 *
 * 规则是**正向**的：出现的域名只允许 example.*。写黑名单等于把要防的那些词写进
 * 公开仓库，正好犯了要防的事。
 */
const dir = new URL("./", import.meta.url).pathname;

// readdirSync 本身不递归。后续任务会加 plugins/jira/public/index.html 和
// plugins/jira/public/jira.js——最容易被人顺手粘进一个真实 URL 试手的文件，
// 所以扫描从一开始就要走进子目录，覆盖面才不会随着目录长深而漏掉。
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(`${path}/`));
    else if (/\.(ts|js|html)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = sourceFiles(dir);

test("插件目录里有文件可查", () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)("%s 里出现的域名只有 example.*", (file) => {
  const source = readFileSync(file, "utf8");
  const hosts = [...source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
  const foreign = hosts.filter(
    (h) => !/(^|\.)example\.(com|net|org)$/.test(h) && !/(^|\.)example\.atlassian\.net$/.test(h),
  );
  expect({ file, foreign }).toEqual({ file, foreign: [] });
});

test.each(files)("%s 里没有邮箱地址，除非是 example 域", (file) => {
  const source = readFileSync(file, "utf8");
  const mails = [...source.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(
    (m) => m[1]!,
  );
  expect({ file, mails: mails.filter((d) => !/(^|\.)example\.(com|net|org)$/.test(d)) })
    .toEqual({ file, mails: [] });
});
