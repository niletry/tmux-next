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

/**
 * 被清洗过的真实名字：公司名、真实会话名、同事名。
 *
 * 这条规则跟这个文件开头那句"不列黑名单"是有冲突的，冲突点很实在：**黑名单本身
 * 就得把要防的名字写进这个公开仓库**。所以名单存的是 SHA-256，不是词本身——扫描
 * 时把源码里的词做同样的哈希再比对。
 *
 * 这是**混淆，不是保密**，别把它当成后者：谁手上已经有候选词，一次哈希就能确认它
 * 在不在名单里。它买到的东西只有一样，但正是要的那样——名字不再以明文出现在仓库
 * 里。想读到名单内容的人本来就已经知道名字了。
 *
 * 为什么值得加：那个公司名用 filter-branch 从全部历史清过一次、当时验证 0 命中，
 * 2026-09-01 又在 src/list-page.test.ts 与 src/agents/task.test.ts 的测试夹具里出现
 * 了 4 处。上面那条规则只咬开发者主目录的绝对路径，咬不到名字，所以没有任何东西
 * 拦得住第三次。
 *
 * 注意这条规则会咬它自己的文档：下面这些注释里因此一个真名字都没有，例子一律用
 * 占位符。第一次跑它就抓住了本文件——那既是它有效的证明，也是这条约束本身。
 *
 * 加一个词：`bun -e 'const h=new Bun.CryptoHasher("sha256");h.update("<小写的词>");
 * console.log(h.digest("hex"))'`，把输出加进下面这张表。只加**独特**的词——把
 * `slack` 这种常见词加进去会误伤一片；确实需要防的多词名字，整条带连字符一起加
 * （下面的分词会同时产出整词与按连字符切开的每一段）。
 */
const BANNED_TOKEN_HASHES = new Set([
  "f9d66d261514e68accc30d53557f1e30d7da496ae7babcb90c0953afa777ec36",
  "cc754dab9eb6a3f3884a2de4b4985f2eaa85ca686a1ae4a41f022bb6f167282b",
  "1ec416295ee819bc6b387aa5f35148f809d5244dee02fc5c2beda9cbc8d01f79",
]);

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

/**
 * 一份源码里出现过的词，小写、去重。
 *
 * 整词与按连字符切开的每一段都算：`acme-spec` 同时产出 `acme-spec`、`acme`、
 * `spec`，于是名单里只存 `acme` 就能咬住 `acme-spec`，不必把每种组合都列一遍。
 * 去重是为了别把同一个词哈希上百次——整个仓库扫下来是几万次，不是几十万次。
 */
function tokensOf(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) {
    const whole = match[0].toLowerCase();
    out.add(whole);
    if (whole.includes("-")) for (const part of whole.split("-")) if (part) out.add(part);
  }
  return out;
}

/** 命中了也不把词原样打出来：首字母 + 长度，够定位，又不在日志里再抄一遍。 */
function mask(token: string): string {
  return `${token[0]}${"*".repeat(Math.max(0, token.length - 1))}(${token.length})`;
}

test.each(sourceFiles)("%s 里没有被清洗过的真实名字", (file) => {
  const source = readFileSync(file, "utf8");
  const hits = [...tokensOf(source)]
    .filter((token) => BANNED_TOKEN_HASHES.has(sha256(token)))
    .map(mask);
  expect({ file, hits }).toEqual({ file, hits: [] });
});
