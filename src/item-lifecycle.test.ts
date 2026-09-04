import { describe, expect, test } from "bun:test";
import { advanceLifecycle, deriveSignal, nextStatus, sanitiseStatus, type ItemStatus } from "./item-lifecycle";
import type { Facet } from "../plugins/types";
import type { WorkItem } from "./items";
import type { ResolvedBinding } from "./session-binding";

function item(status: ItemStatus): WorkItem {
  return {
    id: "it-1",
    title: "测试单",
    source: { provider: "jira", ref: "JIRA-1" },
    tags: [],
    createdAt: 0,
    closedAt: null,
    status,
  };
}

const openPr: Facet = {
  dim: "jira.prs",
  value: "1",
  detail: [{ label: "fix", value: "OPEN", tone: undefined }],
};
const mergedPr: Facet = {
  dim: "jira.prs",
  value: "1",
  detail: [{ label: "fix", value: "MERGED", tone: "dim" }],
};
const declinedPr: Facet = {
  dim: "jira.prs",
  value: "1",
  detail: [{ label: "fix", value: "DECLINED", tone: "warn" }],
};
const checksOk: Facet = { dim: "jira.checks", value: "0/2", tone: "ok" };
const checksFailed: Facet = { dim: "jira.checks", value: "1/2", tone: "warn" };

describe("sanitiseStatus", () => {
  test("认识的值原样放行", () => {
    expect(sanitiseStatus("in_review")).toBe("in_review");
  });
  test("坏值、缺失值都退回默认", () => {
    expect(sanitiseStatus(undefined)).toBe("unclaimed");
    expect(sanitiseStatus("bogus")).toBe("unclaimed");
    expect(sanitiseStatus(42)).toBe("unclaimed");
  });
});

describe("deriveSignal", () => {
  test("没有 PR、没有检查，只看绑定", () => {
    expect(deriveSignal([], true)).toEqual({
      hasLiveBinding: true,
      hasOpenPr: false,
      prMerged: false,
      checksAllOk: false,
    });
  });

  test("有一个开着的 PR", () => {
    const s = deriveSignal([openPr], true);
    expect(s.hasOpenPr).toBe(true);
    expect(s.prMerged).toBe(false);
  });

  test("PR 已合并、没有开着的了", () => {
    const s = deriveSignal([mergedPr], true);
    expect(s.hasOpenPr).toBe(false);
    expect(s.prMerged).toBe(true);
  });

  test("只有被拒绝的 PR 不算合并、也不算开着", () => {
    const s = deriveSignal([declinedPr], true);
    expect(s.hasOpenPr).toBe(false);
    expect(s.prMerged).toBe(false);
  });

  test("checks facet 缺席时 checksAllOk 是 false——没查到不等于过了", () => {
    expect(deriveSignal([openPr], true).checksAllOk).toBe(false);
  });

  test("checks 全绿才是 checksAllOk", () => {
    expect(deriveSignal([openPr, checksOk], true).checksAllOk).toBe(true);
    expect(deriveSignal([openPr, checksFailed], true).checksAllOk).toBe(false);
  });
});

describe("nextStatus", () => {
  const no = { hasLiveBinding: false, hasOpenPr: false, prMerged: false, checksAllOk: false };

  test("unclaimed → in_progress：出现活着的绑定", () => {
    expect(nextStatus("unclaimed", { ...no, hasLiveBinding: true })).toBe("in_progress");
  });
  test("unclaimed 原地不动：没有绑定", () => {
    expect(nextStatus("unclaimed", no)).toBe("unclaimed");
  });

  test("in_progress → in_review：出现开着的 PR", () => {
    expect(nextStatus("in_progress", { ...no, hasLiveBinding: true, hasOpenPr: true })).toBe(
      "in_review",
    );
  });
  test("in_progress → unclaimed：绑定死了，也没有任何 PR 痕迹", () => {
    expect(nextStatus("in_progress", no)).toBe("unclaimed");
  });
  test("in_progress 原地不动：还绑着，但还没开 PR", () => {
    expect(nextStatus("in_progress", { ...no, hasLiveBinding: true })).toBe("in_progress");
  });

  test("in_review → in_merge：PR 还开着，checks 全绿", () => {
    expect(nextStatus("in_review", { ...no, hasOpenPr: true, checksAllOk: true })).toBe(
      "in_merge",
    );
  });
  test("in_review 原地不动：PR 开着但 checks 没全绿", () => {
    expect(nextStatus("in_review", { ...no, hasOpenPr: true })).toBe("in_review");
  });
  test("in_review → done：PR 直接合并了（不必先经过 in_merge）", () => {
    expect(nextStatus("in_review", { ...no, prMerged: true })).toBe("done");
  });
  test("in_review 不因为绑定死了就回退——不可逆", () => {
    expect(nextStatus("in_review", no)).toBe("in_review");
  });

  test("in_merge → done：合并了", () => {
    expect(nextStatus("in_merge", { ...no, prMerged: true })).toBe("done");
  });
  test("in_merge 原地不动：还没合并", () => {
    expect(nextStatus("in_merge", { ...no, hasOpenPr: true, checksAllOk: true })).toBe(
      "in_merge",
    );
  });

  test("done 是终态", () => {
    expect(nextStatus("done", { ...no, hasLiveBinding: true })).toBe("done");
  });
});

describe("advanceLifecycle", () => {
  function binding(itemId: string, live: boolean): ResolvedBinding {
    return { session: "s", itemId, live };
  }

  test("没有变化的单不出现在结果里", () => {
    const items = [item("unclaimed")];
    const out = advanceLifecycle(items, {}, []);
    expect(out).toEqual([]);
  });

  test("变化的单带着 from/to 出现", () => {
    const items = [item("unclaimed")];
    const out = advanceLifecycle(items, {}, [binding("it-1", true)]);
    expect(out).toEqual([{ item: items[0], from: "unclaimed", to: "in_progress" }]);
  });

  test("死掉的绑定不算活着", () => {
    const items = [item("unclaimed")];
    const out = advanceLifecycle(items, {}, [binding("it-1", false)]);
    expect(out).toEqual([]);
  });

  test("一批里只有真的变化的那些出现", () => {
    const a = item("unclaimed");
    const b = { ...item("in_progress"), id: "it-2" };
    const out = advanceLifecycle([a, b], { "it-2": [openPr] }, [
      binding("it-1", false),
      binding("it-2", true),
    ]);
    expect(out).toEqual([{ item: b, from: "in_progress", to: "in_review" }]);
  });
});
