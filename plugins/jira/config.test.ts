import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJiraConfig, writeJiraConfig, DEFAULT_JQL } from "./config";

/**
 * 凭据落盘的那一份。存的是能读用户 Jira 的东西，所以这里检的不只是"存得进读得出"，
 * 还有权限位——一个 0644 的 token 文件，跟没存加密没两样。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jira-cfg-"));
  saved = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有配置文件时读出 null，而不是抛", async () => {
  // 绝大多数装机是没配过的，这不值得让一个页面加载失败。
  expect(await readJiraConfig()).toBeNull();
});

test("坏 JSON 也读成 null", async () => {
  await writeFile(join(root, "config.json"), "{ not json");
  expect(await readJiraConfig()).toBeNull();
});

test("缺任一必填项就读成 null", async () => {
  for (const partial of [
    { email: "dev@example.com", token: "t" },
    { url: "https://example.atlassian.net", token: "t" },
    { url: "https://example.atlassian.net", email: "dev@example.com" },
    { url: "  ", email: "dev@example.com", token: "t" },
  ]) {
    await writeFile(join(root, "config.json"), JSON.stringify(partial));
    expect({ partial, cfg: await readJiraConfig() }).toEqual({ partial, cfg: null });
  }
});

test("写进去读得回来，JQL 缺省时补默认值", async () => {
  await writeJiraConfig({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "secret-token",
    jql: "",
    onlyKeyedPrs: true,
  });
  const cfg = await readJiraConfig();
  expect(cfg?.url).toBe("https://example.atlassian.net");
  expect(cfg?.email).toBe("dev@example.com");
  expect(cfg?.jql).toBe(DEFAULT_JQL);
});

test("配置文件只有属主可读写", async () => {
  await writeJiraConfig({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "secret-token",
    jql: "",
    onlyKeyedPrs: true,
  });
  const s = await stat(join(root, "config.json"));
  // 0600。同机器上的别的用户不该能读到这个 token。
  expect(s.mode & 0o777).toBe(0o600);
});

test("末尾斜杠被吃掉，好让 URL 拼接不出双斜杠", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ url: "https://example.atlassian.net/", email: "dev@example.com", token: "t" }),
  );
  expect((await readJiraConfig())?.url).toBe("https://example.atlassian.net");
});

test("onlyKeyedPrs 缺省即开，只有显式 false 才关", async () => {
  // 默认过滤，是因为 dev-status 的关联很松：实测三个单里两个挂着别人的 PR。
  // 一条挂错的 PR 会骗人，而被滤掉的那些有计数摆在界面上。
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ url: "https://example.atlassian.net", email: "dev@example.com", token: "t" }),
  );
  expect((await readJiraConfig())?.onlyKeyedPrs).toBe(true);

  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      url: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "t",
      onlyKeyedPrs: false,
    }),
  );
  expect((await readJiraConfig())?.onlyKeyedPrs).toBe(false);
});
