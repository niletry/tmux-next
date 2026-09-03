import { test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。路径在函数体里现读，所以设在 import 之前就够。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_TEMPLATES_PATH = join(tmpdir(), `templates-test-${stamp}.json`);

import { rm, writeFile } from "node:fs/promises";
import {
  readTemplates,
  writeTemplates,
  templatesPath,
  MAX_TEMPLATES,
  MAX_LABEL,
  MAX_INPUT,
} from "./templates";

afterEach(async () => {
  await rm(templatesPath(), { force: true });
});

test("没有文件时读成空表", async () => {
  expect(await readTemplates()).toEqual([]);
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(templatesPath(), "{ not json");
  expect(await readTemplates()).toEqual([]);
});

test("写进去再读出来", async () => {
  await writeTemplates([{ label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }]);
  const got = await readTemplates();
  expect(got.length).toBe(1);
  expect(got[0]!.label).toBe("修 bug");
  expect(got[0]!.name).toBe("{item.ref}");
  expect(got[0]!.input).toBe("修 {item.title}");
});

test("没给 id 的会补一个，给了的保留", async () => {
  const written = await writeTemplates([
    { label: "a", name: "", input: "" },
    { id: "tpl-keepme", label: "b", name: "", input: "" },
  ]);
  expect(written[0]!.id).toMatch(/^tpl-/);
  expect(written[1]!.id).toBe("tpl-keepme");
});

// label 是选择器上唯一能认出它的东西，没有就不是一个模板。
test("label 为空的记录被丢掉", async () => {
  const written = await writeTemplates([{ label: "  ", name: "x", input: "" }]);
  expect(written).toEqual([]);
});

test("name 和 input 缺了当空串，不丢整条", async () => {
  const written = await writeTemplates([{ label: "只有标题模板" } as unknown]);
  expect(written.length).toBe(1);
  expect(written[0]!.name).toBe("");
  expect(written[0]!.input).toBe("");
});

test("不是数组时写成空表", async () => {
  expect(await writeTemplates({ nope: true })).toEqual([]);
  expect(await readTemplates()).toEqual([]);
});

test("超过 MAX_TEMPLATES 的部分被截掉", async () => {
  const many = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => ({
    label: `t${i}`,
    name: "",
    input: "",
  }));
  expect((await writeTemplates(many)).length).toBe(MAX_TEMPLATES);
});

test("过长的 label 和 input 被截断", async () => {
  const written = await writeTemplates([
    { label: "x".repeat(MAX_LABEL + 20), name: "", input: "y".repeat(MAX_INPUT + 20) },
  ]);
  expect(written[0]!.label.length).toBe(MAX_LABEL);
  expect(written[0]!.input.length).toBe(MAX_INPUT);
});

test("整份替换：第二次写会盖掉第一次", async () => {
  await writeTemplates([{ label: "旧", name: "", input: "" }]);
  await writeTemplates([{ label: "新", name: "", input: "" }]);
  const got = await readTemplates();
  expect(got.length).toBe(1);
  expect(got[0]!.label).toBe("新");
});
