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

/**
 * 一条字符串字面量，写死成 `/Users/<name>/…某源文件`、`/home/<name>/…某源文件`。
 *
 * 两次真实事故:list-annotations.test.ts 和 list-page.test.ts 各写死过一条形如
 * 「主目录 / 项目路径 / worktrees / 某个 worktree 名字 / public / list__dot__js」
 * 的绝对路径（此处特意拆开写，避免这条注释自己触发下面这条规则），结果测试悄
 * 悄读了**主仓库**那份文件而不是当前 worktree 改过的这份——改坏 public/list.js
 * 到语法错误，测试照样全绿。这条规则钉住的正是"能跑但跑的不是你以为的文件"这
 * 类静默错误，而不是开发者主目录路径本身好不好看。
 *
 * 因此只锁"指向一个源文件"的字符串——以 .ts/.tsx/.js/.jsx/.css/.html 收尾、
 * 引号包住的绝对路径。这条线特意画在这里，而不是禁掉任何含 `/Users/<name>/`
 * 的字符串：src/dir-filter.test.ts、src/claude-history.test.ts 等文件里大量存在
 * 拿 `/Users/you/...`、`/home/sam/...` 当示例数据去测纯路径处理函数的用法（不
 * 解析成真实文件，参数本身就是被测函数的输入），这些是正当用法，不该被这条规
 * 则误伤——黑名单只咬"曾经真的咬过人"的那个形状。
 *
 * 扫描范围从 src/ 扩到 public/、plugins/：这个错误在这三处任何一处都会重演——
 * public/ 是被写死路径指向的一方，plugins/ 的服务端代码同样可能拼出这种路径。
 *
 * 正确写法：`new URL("../public/x.js", import.meta.url).pathname`，worktree
 * 一换照样找得到文件。
 */
const ROOT = new URL("../", import.meta.url).pathname;
const SOURCE_DIRS = ["src", "public", "plugins"];
const SOURCE_EXT = /\.(ts|js|css|html)$/;

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...allSourceFiles(`${path}/`));
    else if (SOURCE_EXT.test(entry.name)) out.push(path);
  }
  return out;
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => allSourceFiles(`${ROOT}${d}/`));

test("src/、public/、plugins/ 下有源文件可查", () => {
  expect(sourceFiles.length).toBeGreaterThan(0);
});

const HOME_PATH_TO_SOURCE_FILE =
  /["'`]\/(Users|home)\/([A-Za-z0-9_.-]+)\/([^"'`]*?\.(?:ts|tsx|js|jsx|css|html))["'`]/g;
// 单字母占位符（跟上面 ALLOWED_HOST 同一约定）：last-action.test.ts 用
// `/Users/x/projects/app/server.ts` 当 Read/Edit 工具调用里 file_path 参数的
// 示例数据，形状像源文件路径，但 "x" 不指向任何真人主目录，不是这条规则要咬的
// 对象。
const ALLOWED_HOME_USER = /^[a-z]$/i;
const USE_INSTEAD = 'new URL("../public/x.js", import.meta.url).pathname';

test.each(sourceFiles)("%s 里没有写死进开发者主目录、指向某个源文件的绝对路径", (file) => {
  const source = readFileSync(file, "utf8");
  const offenders = [...source.matchAll(HOME_PATH_TO_SOURCE_FILE)]
    .filter((m) => !ALLOWED_HOME_USER.test(m[2]!))
    .map((m) => `/${m[1]}/${m[2]}/${m[3]}`);
  expect({ file, offenders, useInstead: USE_INSTEAD }).toEqual({
    file,
    offenders: [],
    useInstead: USE_INSTEAD,
  });
});
