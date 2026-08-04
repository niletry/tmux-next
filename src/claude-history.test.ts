import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, parseHistoryHead, listHistory } from "./claude-history";

test("encodeProjectDir turns every / and . into -", () => {
  expect(encodeProjectDir("/Users/you/projects/tmux-next")).toBe("-Users-you-projects-tmux-next");
  expect(encodeProjectDir("/private/tmp/cwd.demo")).toBe("-private-tmp-cwd-demo");
  expect(encodeProjectDir("/a/b/")).toBe("-a-b"); // trailing slash ignored
});

const line = (o: unknown) => JSON.stringify(o);

test("parseHistoryHead prefers ai-title", () => {
  const text = [
    line({ type: "ai-title", aiTitle: "修复登录 bug" }),
    line({ type: "user", cwd: "/w", message: { role: "user", content: "帮我看下登录" } }),
  ].join("\n");
  expect(parseHistoryHead(text)).toEqual({ title: "修复登录 bug", cwd: "/w" });
});

test("parseHistoryHead falls back to the first user message", () => {
  const text = [
    line({ type: "file-history-snapshot" }),
    line({ type: "user", cwd: "/w", message: { role: "user", content: "  第一句  " } }),
    line({ type: "user", message: { role: "user", content: "第二句" } }),
  ].join("\n");
  expect(parseHistoryHead(text)).toEqual({ title: "第一句", cwd: "/w" });
});

test("parseHistoryHead joins text blocks when content is an array", () => {
  const text = line({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "看" }, { type: "image" }, { type: "text", text: "这个" }] },
  });
  expect(parseHistoryHead(text).title).toBe("看 这个");
});

test("parseHistoryHead returns null title when nothing usable, and tolerates a truncated last line", () => {
  const text = line({ type: "file-history-snapshot", cwd: "/w" }) + '\n{"type":"user","messa';
  expect(parseHistoryHead(text)).toEqual({ title: null, cwd: "/w" });
});

// --- listHistory against a temp CLAUDE_PROJECTS_DIR --------------------------

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hist-"));
  saved = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

async function writeConvo(dir: string, id: string, aiTitle: string, cwd: string, mtimeSec: number) {
  const folder = join(root, encodeProjectDir(dir));
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${id}.jsonl`);
  await writeFile(
    file,
    [
      line({ type: "ai-title", aiTitle }),
      line({ type: "user", cwd, message: { role: "user", content: "hi" } }),
    ].join("\n"),
  );
  await utimes(file, mtimeSec, mtimeSec);
}

test("listHistory returns titled conversations newest first", async () => {
  const dir = "/Users/x/proj";
  await writeConvo(dir, "aaaaaaaa-old", "旧对话", dir, 1000);
  await writeConvo(dir, "bbbbbbbb-new", "新对话", dir, 2000);

  const out = await listHistory(dir);
  expect(out.map((e) => e.title)).toEqual(["新对话", "旧对话"]);
  expect(out.map((e) => e.id)).toEqual(["bbbbbbbb-new", "aaaaaaaa-old"]);
});

test("listHistory drops a transcript whose recorded cwd disagrees", async () => {
  const dir = "/Users/x/proj";
  await writeConvo(dir, "keep", "对的", dir, 2000);
  await writeConvo(dir, "wrong", "错的", "/somewhere/else", 3000); // lands in same folder but cwd differs

  const out = await listHistory(dir);
  expect(out.map((e) => e.id)).toEqual(["keep"]);
});

test("listHistory is empty when the project folder does not exist", async () => {
  expect(await listHistory("/no/such/dir")).toEqual([]);
});
