import { test, expect } from "bun:test";
import { pickSessionName } from "./public/session-name.js";

test("会话名没被占用时直接用工单号", () => {
  expect(pickSessionName("EXAMPLE-1", [])).toBe("EXAMPLE-1");
  expect(pickSessionName("EXAMPLE-1", ["EXAMPLE-2", "other"])).toBe("EXAMPLE-1");
});

test("工单号被占用时挑第一个空着的 -2、-3……", () => {
  expect(pickSessionName("EXAMPLE-1", ["EXAMPLE-1"])).toBe("EXAMPLE-1-2");
  expect(pickSessionName("EXAMPLE-1", ["EXAMPLE-1", "EXAMPLE-1-2"])).toBe("EXAMPLE-1-3");
});

test("中间的编号空出来也不回填——只找第一个当前没人占的", () => {
  // EXAMPLE-1-2 空着，但 EXAMPLE-1-3 被占——挑号从 -2 起顺着找，遇到第一个空的就
  // 停，不是找"最小没被占用过"的号。
  expect(pickSessionName("EXAMPLE-1", ["EXAMPLE-1", "EXAMPLE-1-3"])).toBe("EXAMPLE-1-2");
});

test("不占用别的工单撞名的会话名", () => {
  expect(pickSessionName("EXAMPLE-1", ["EXAMPLE-2-2"])).toBe("EXAMPLE-1");
});
