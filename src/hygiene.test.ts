import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * 同一条卫生规则,从 plugins/jira/ 扩到 src/。
 *
 * plugins/jira/fixtures.test.ts 已经在守插件目录:出现的域名只能是
 * example.*。但那条规则只覆盖了插件目录——src/list-annotations.test.ts 里出现
 * 过一条写死的本机 worktree 路径,证明 src/ 下的卫生目前只靠作者自觉,没有测试
 * 钉着。
 *
 * 规则照旧是**正向**的:允许出现的域名/邮箱写成白名单,而不是列一份"不能出现
 * 什么"的黑名单——黑名单本身就得把要防的名字写进这个公开仓库。
 *
 * src/ 下合法地会出现 example.* 以外的东西:localhost、127.0.0.1，以及单元测
 * 试里当占位符用的单字母主机名(如 push.test.ts 的 "https://x")。这些都在允
 * 许列表里显式放开,而不是放宽正则本身。
 */
const dir = new URL("./", import.meta.url).pathname;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...testFiles(`${path}/`));
    else if (/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = testFiles(dir);

const ALLOWED_HOST =
  /^(localhost|127\.0\.0\.1|[a-z])$/i; // 占位符主机名 + 本机地址,逐条列出
const ALLOWED_EXAMPLE_HOST = /(^|\.)example\.(com|net|org)$/;
const ALLOWED_JIRA_HOST = /(^|\.)example\.atlassian\.net$/;

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOST.test(host) || ALLOWED_EXAMPLE_HOST.test(host) || ALLOWED_JIRA_HOST.test(host);
}

test("src/ 下有测试文件可查", () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)("%s 里出现的域名只有 example.* 或本地占位符", (file) => {
  const source = readFileSync(file, "utf8");
  const hosts = [...source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
  const foreign = hosts.filter((h) => !isAllowedHost(h));
  expect({ file, foreign }).toEqual({ file, foreign: [] });
});

test.each(files)("%s 里没有邮箱地址，除非是 example 域", (file) => {
  const source = readFileSync(file, "utf8");
  const mails = [...source.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(
    (m) => m[1]!,
  );
  expect({ file, mails: mails.filter((d) => !ALLOWED_EXAMPLE_HOST.test(d)) }).toEqual({
    file,
    mails: [],
  });
});
