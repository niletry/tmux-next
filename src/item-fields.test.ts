import { test, expect } from "bun:test";
import { kernelFields, KERNEL_FIELD_KEYS } from "./item-fields";
import type { WorkItem } from "./items";

const item = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: "it-1",
  title: "修登录页",
  source: { provider: "jira", ref: "EXAMPLE-1", url: "https://x.example/EXAMPLE-1" },
  tags: ["前端", "紧急"],
  createdAt: 0,
  closedAt: null,
  ...extra,
});

test("挂了来源的单，六个字段都有值", () => {
  expect(kernelFields(item())).toEqual({
    "item.id": "it-1",
    "item.title": "修登录页",
    "item.provider": "jira",
    "item.ref": "EXAMPLE-1",
    "item.url": "https://x.example/EXAMPLE-1",
    "item.tags": "前端, 紧急",
  });
});

// 本地单跟挂了工单的单是同一种东西，只是来源那三格是空字符串——不是 undefined，
// 否则 render 里的 `fields[key] ?? ""` 和"这一行全空"的判断会走两条路。
test("本地单的来源三格是空字符串", () => {
  const got = kernelFields(item({ source: null, tags: [] }));
  expect(got["item.provider"]).toBe("");
  expect(got["item.ref"]).toBe("");
  expect(got["item.url"]).toBe("");
  expect(got["item.tags"]).toBe("");
});

test("来源没带 url 时那一格是空字符串", () => {
  const got = kernelFields(item({ source: { provider: "jira", ref: "E-1" } }));
  expect(got["item.url"]).toBe("");
});

// 设置页要把可用字段列给用户看，键名从服务端来（GET /api/templates），
// 所以这张表必须跟 kernelFields 真正产出的键完全一致。
test("KERNEL_FIELD_KEYS 跟实际产出的键一一对应", () => {
  expect([...KERNEL_FIELD_KEYS].sort()).toEqual(Object.keys(kernelFields(item())).sort());
});
