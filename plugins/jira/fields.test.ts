import { test, expect } from "bun:test";
import { fields, DESC_CACHE_MS } from "./server";
import type { ItemRef } from "../types";

/**
 * `fields()` 喂给模板的字段——一次真实请求都不发：描述正文那一步走的是注入的
 * `getDescription`，不是真的 `fetchIssueDescription`/`fetch`。
 *
 * 每个用例用不同的 `ref` 当 key，是因为描述缓存是模块级的 `Map`，用同一个 key
 * 会让不同用例的缓存状态互相串。
 */

test("非 jira 来源的单返回 {}，一次请求都不发", async () => {
  let calls = 0;
  const getDescription = async () => {
    calls++;
    return "不该被叫到";
  };
  const item: ItemRef = { id: "it-1", source: { provider: "github", ref: "GH-1" } };
  expect(await fields(item, getDescription)).toEqual({});
  expect(calls).toBe(0);
});

test("没有来源的单返回 {}，一次请求都不发", async () => {
  let calls = 0;
  const getDescription = async () => {
    calls++;
    return "不该被叫到";
  };
  const item: ItemRef = { id: "it-2", source: null };
  expect(await fields(item, getDescription)).toEqual({});
  expect(calls).toBe(0);
});

test("同一个单连问两次，缓存命中时不重新发请求", async () => {
  let calls = 0;
  const getDescription = async () => {
    calls++;
    return "登录页描述";
  };
  const item: ItemRef = { id: "it-3", source: { provider: "jira", ref: "FIELD-CACHE-HIT" } };
  const now = () => 1_000_000; // 两次调用停在同一时刻，必然落在缓存窗口内

  const first = await fields(item, getDescription, now);
  const second = await fields(item, getDescription, now);

  expect(first["jira.description"]).toBe("登录页描述");
  expect(second["jira.description"]).toBe("登录页描述");
  expect(calls).toBe(1);
});

// 这是这轮最要紧的一条：描述缓存里存的是 `string | null`，"这个单真的没有描述"
// 跟"还没问过"是两个不同的状态，混起来会让没有描述的单每次都重新发请求。
test("缓存过期后重新发请求；这个单真的没有描述（null）时也走缓存，不是每次重问", async () => {
  let calls = 0;
  const getDescription = async () => {
    calls++;
    return null; // 这张单真的没写描述
  };
  const item: ItemRef = { id: "it-4", source: { provider: "jira", ref: "FIELD-CACHE-NULL" } };
  let clock = 0;
  const now = () => clock;

  const first = await fields(item, getDescription, now);
  expect(first["jira.description"]).toBeUndefined();
  expect(calls).toBe(1); // 第一次：没问过，发了一次请求

  clock += 1000; // 远小于缓存窗口
  const second = await fields(item, getDescription, now);
  expect(second["jira.description"]).toBeUndefined();
  expect(calls).toBe(1); // null 也是"问到过"，缓存住了，不重新发请求

  clock += DESC_CACHE_MS + 1; // 缓存过期
  await fields(item, getDescription, now);
  expect(calls).toBe(2); // 过期后才重新问
});
