import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "json-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("文件不存在时读出 fallback", async () => {
  expect(await readJson(join(root, "nope.json"), { a: 1 })).toEqual({ a: 1 });
});

test("坏 JSON 读出 fallback，不抛", async () => {
  const path = join(root, "bad.json");
  await writeFile(path, "{ not json");
  expect(await readJson(path, {})).toEqual({});
});

test("写得进读得回", async () => {
  const path = join(root, "ok.json");
  await writeJsonAtomic(path, { hello: "世界" });
  expect(await readJson(path, {})).toEqual({ hello: "世界" });
});

test("写入不留临时文件", async () => {
  const path = join(root, "ok.json");
  await writeJsonAtomic(path, { a: 1 });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(root)).toEqual(["ok.json"]);
});

test("目录不存在时自己建出来", async () => {
  const path = join(root, "deep", "nested", "x.json");
  await writeJsonAtomic(path, { a: 1 });
  expect(await readJson(path, {})).toEqual({ a: 1 });
});

test("sanitise 决定读出来的形状", async () => {
  const path = join(root, "s.json");
  await writeFile(path, JSON.stringify({ keep: 1, drop: 2 }));
  const got = await readJson(path, {} as Record<string, number>, (raw) => {
    const r = raw as Record<string, unknown>;
    return typeof r?.keep === "number" ? { keep: r.keep } : ({} as Record<string, number>);
  });
  expect(got).toEqual({ keep: 1 });
});

// 这条是整个模块存在的理由：三个并发的读-改-写，一条都不能丢。
test("并发的读-改-写不丢更新", async () => {
  const path = join(root, "c.json");
  await writeJsonAtomic(path, {} as Record<string, number>);

  const bump = (key: string) =>
    serialized(async () => {
      const all = await readJson<Record<string, number>>(path, {});
      all[key] = 1;
      await writeJsonAtomic(path, all);
    });

  await Promise.all([bump("a"), bump("b"), bump("c")]);
  expect(await readJson(path, {})).toEqual({ a: 1, b: 1, c: 1 });
});

test("队列里一个任务抛了，后面的照跑", async () => {
  const seen: string[] = [];
  const boom = serialized(async () => {
    throw new Error("boom");
  });
  await expect(boom).rejects.toThrow("boom");
  await serialized(async () => {
    seen.push("after");
  });
  expect(seen).toEqual(["after"]);
});
