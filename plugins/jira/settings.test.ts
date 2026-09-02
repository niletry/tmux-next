import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jira-settings-"));
process.env.TMUX_NEXT_JIRA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { readSettings, writeSettings } = await import("./server");
const { readJiraConfig, writeJiraConfig, DEFAULT_JQL } = await import("./config");

/**
 * Jira 的配置读写。
 *
 * 这一组盯的是密钥"只写不读"带来的那条不显然的规则：**页面拿不到旧值，于是"没动
 * 这一格"和"想清空这一格"在请求里长得一样**。二者只能取一，取的是保留旧值。
 */

const full = {
  url: "https://example.atlassian.net",
  email: "me@example.com",
  token: "tok-1",
  jql: "assignee = currentUser()",
  onlyKeyedPrs: true,
};

beforeEach(async () => {
  rmSync(join(dir, "config.json"), { force: true });
});

test("没配过时读出空壳，而不是抛", async () => {
  const got = await readSettings();
  expect(got.url).toBe("");
  expect(got.token).toBe(false);
  // JQL 报的是将会用上的那条默认值，不是空——空会让人以为默认是"什么都不查"。
  expect(got.jql).toBe(DEFAULT_JQL);
  expect(got.onlyKeyedPrs).toBe(true);
});

test("读回来的两个密钥都是布尔，不是值", async () => {
  await writeJiraConfig({ ...full, bitbucket: { email: "b@example.com", appPassword: "bb-pass" } });
  const got = await readSettings();
  expect(got.token).toBe(true);
  expect(got["bitbucket.appPassword"]).toBe(true);
  expect(JSON.stringify(got)).not.toContain("tok-1");
  expect(JSON.stringify(got)).not.toContain("bb-pass");
  // 非密钥照常回值——页面要显示"连的是哪个实例"。
  expect(got.url).toBe(full.url);
  expect(got["bitbucket.email"]).toBe("b@example.com");
});

// 这是整组里最要紧的一条。
test("留空的密钥表示不改，不是清空", async () => {
  await writeJiraConfig(full);
  await writeSettings({ url: full.url, email: full.email, token: "", jql: full.jql });
  expect((await readJiraConfig())?.token).toBe("tok-1");
});

test("填了新密钥就替换", async () => {
  await writeJiraConfig(full);
  await writeSettings({ url: full.url, email: full.email, token: "tok-2" });
  expect((await readJiraConfig())?.token).toBe("tok-2");
});

test("只填了空白的密钥同样算不改", async () => {
  await writeJiraConfig(full);
  await writeSettings({ url: full.url, email: full.email, token: "   " });
  expect((await readJiraConfig())?.token).toBe("tok-1");
});

// readJiraConfig 本来就把半份配置读成"没配过"。存下一份注定读不出来的东西，
// 只会让人以为存成了。
test("三项必填缺一就拒绝写入", async () => {
  await expect(writeSettings({ url: "https://example.atlassian.net", email: "", token: "t" })).rejects.toThrow();
  await expect(writeSettings({ url: "", email: "a@b", token: "t" })).rejects.toThrow();
  // 从没配过、又没给 token，也是缺（没有旧值可继承）
  await expect(writeSettings({ url: "https://example.atlassian.net", email: "a@b", token: "" })).rejects.toThrow();
});

test("末尾斜杠被去掉", async () => {
  await writeSettings({ url: "https://example.atlassian.net///", email: "a@b", token: "t" });
  expect((await readJiraConfig())?.url).toBe("https://example.atlassian.net");
});

test("JQL 留空落回默认值", async () => {
  await writeSettings({ url: "https://example.atlassian.net", email: "a@b", token: "t", jql: "" });
  expect((await readJiraConfig())?.jql).toBe(DEFAULT_JQL);
});

test("开关按布尔存，没给就保持原样", async () => {
  await writeSettings({ url: "https://example.atlassian.net", email: "a@b", token: "t", onlyKeyedPrs: false });
  expect((await readJiraConfig())?.onlyKeyedPrs).toBe(false);
  // 这次不带这个键：不该被当成 false
  await writeSettings({ url: "https://example.atlassian.net", email: "a@b", token: "" });
  expect((await readJiraConfig())?.onlyKeyedPrs).toBe(false);
});

// 半份 Bitbucket 拿去打的每个请求都必然 401，而界面会把那说成"检查没问到"——
// 比诚实地说"没配"更糟。
test("只有邮箱没有密码时不写 bitbucket", async () => {
  await writeSettings({
    url: "https://example.atlassian.net", email: "a@b", token: "t",
    "bitbucket.email": "b@example.com", "bitbucket.appPassword": "",
  });
  expect((await readJiraConfig())?.bitbucket).toBeUndefined();
});

test("两项齐了才写 bitbucket", async () => {
  await writeSettings({
    url: "https://example.atlassian.net", email: "a@b", token: "t",
    "bitbucket.email": "b@example.com", "bitbucket.appPassword": "bb",
  });
  expect((await readJiraConfig())?.bitbucket).toEqual({ email: "b@example.com", appPassword: "bb" });
});

// 密钥不回填，所以第二次保存必然带着空的 appPassword——不继承的话，改一次 JQL
// 就会把 Bitbucket 配没了。
test("再存一次不会把已有的 bitbucket 弄丢", async () => {
  await writeJiraConfig({ ...full, bitbucket: { email: "b@example.com", appPassword: "bb" } });
  await writeSettings({
    url: full.url, email: full.email, token: "",
    jql: "新的 JQL", "bitbucket.email": "b@example.com", "bitbucket.appPassword": "",
  });
  const after = await readJiraConfig();
  expect(after?.bitbucket).toEqual({ email: "b@example.com", appPassword: "bb" });
  expect(after?.jql).toBe("新的 JQL");
});

test("写出来的文件是 0600", async () => {
  await writeSettings({ url: "https://example.atlassian.net", email: "a@b", token: "t" });
  const { statSync } = await import("node:fs");
  expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
});
