import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { openPicker } from "../public/pick-sheet.js";

/**
 * 两个方向共用的选择浮层。
 *
 * 它刻意不认识 i18n——文案全由调用方传入——所以这里可以直接拿字面量测，不必先
 * 搭一套字典环境，也不会因为改了某个键的译文而红。
 */

let win: Window | null = null;
/** @returns 一个空白文档 */
function doc() {
  win = new Window({ url: "http://127.0.0.1:7682/" });
  win.document.body.innerHTML = "";
  return win.document as unknown as Document;
}
afterEach(() => {
  win?.close?.();
  win = null;
});

const base = {
  title: "关联到单",
  emptyText: "还没有单",
  cancelText: "取消",
  failedText: "关联失败",
};

const click = (n: unknown) =>
  (n as { dispatchEvent: (e: unknown) => void } | null)?.dispatchEvent(
    new (win as any).Event("click", { bubbles: true }),
  );

test("一行一个候选，选中的那个标出来但仍然可点", () => {
  const d = doc();
  openPicker({
    ...base,
    options: [
      { id: "a", label: "修登录页" },
      { id: "b", label: "改搜索", current: true },
    ],
    onPick: () => {},
  }, d);

  const rows = [...d.querySelectorAll(".pick-row")];
  expect(rows.length).toBe(2);
  expect(rows[1]!.className).toContain("current");
  expect((rows[1]! as HTMLButtonElement).disabled).toBe(false);
});

test("note 显示在候选行上", () => {
  const d = doc();
  openPicker({
    ...base,
    options: [{ id: "a", label: "甲", note: "现挂在「改搜索」下" }],
    onPick: () => {},
  }, d);
  expect(d.querySelector(".pick-note")?.textContent).toBe("现挂在「改搜索」下");
});

test("点一行把它的 id 交给回调，然后收起浮层", async () => {
  const d = doc();
  const picked: string[] = [];
  openPicker({ ...base, options: [{ id: "s-1", label: "甲" }], onPick: (id) => { picked.push(id); } }, d);

  click(d.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 10));
  expect(picked).toEqual(["s-1"]);
  expect(d.querySelector(".sheet-backdrop")).toBeNull();
});

// 失败之后把人扔回列表，他既不知道成没成，也得重新找一遍。
test("回调抛了：浮层留着、显示失败、还能再点", async () => {
  const d = doc();
  let calls = 0;
  openPicker({
    ...base,
    options: [{ id: "s-1", label: "甲" }],
    onPick: () => { calls += 1; throw new Error("boom"); },
  }, d);

  click(d.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 10));
  expect(d.querySelector(".sheet-backdrop")).not.toBeNull();
  const err = d.querySelector(".sheet-error") as HTMLElement;
  expect(err.hidden).toBe(false);
  expect(err.textContent).toBe("关联失败");

  click(d.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toBe(2);
});

// 一次点击还没回来时又点一下，不能打出第二个请求。
test("处理中不接受第二次点击", async () => {
  const d = doc();
  let calls = 0;
  openPicker({
    ...base,
    options: [{ id: "s-1", label: "甲" }],
    onPick: async () => { calls += 1; await new Promise((r) => setTimeout(r, 40)); },
  }, d);

  click(d.querySelector(".pick-row"));
  click(d.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 80));
  expect(calls).toBe(1);
});

// 卡在慢请求上时，取消必须还按得动——否则只能刷新页面才能退出去。
test("处理中取消仍然可用", async () => {
  const d = doc();
  openPicker({
    ...base,
    options: [{ id: "s-1", label: "甲" }],
    onPick: async () => { await new Promise((r) => setTimeout(r, 100)); },
  }, d);

  click(d.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 10));
  const buttons = [...d.querySelectorAll(".sheet-actions .btn")] as HTMLButtonElement[];
  const cancel = buttons.find((b) => b.textContent === "取消")!;
  expect(cancel.disabled).toBe(false);
  click(cancel);
  expect(d.querySelector(".sheet-backdrop")).toBeNull();
});

test("一个候选都没有时说清楚，而不是给一张空白纸", () => {
  const d = doc();
  openPicker({ ...base, options: [], onPick: () => {} }, d);
  expect(d.querySelector(".sheet-warn")?.textContent).toBe("还没有单");
  expect(d.querySelector(".pick-row")).toBeNull();
});

// 没挂东西的时候画一个"解除"按钮，等于让人怀疑自己是不是记错了。
test("clear 只在传了的时候才画", () => {
  const d = doc();
  openPicker({ ...base, options: [{ id: "a", label: "甲" }], onPick: () => {} }, d);
  expect(d.querySelector(".btn.danger")).toBeNull();

  const d2 = doc();
  let cleared = 0;
  openPicker({
    ...base,
    options: [{ id: "a", label: "甲" }],
    onPick: () => {},
    clear: { label: "解除关联", onPick: () => { cleared += 1; } },
  }, d2);
  const clear = d2.querySelector(".btn.danger")!;
  expect(clear.textContent).toBe("解除关联");
  click(clear);
  expect(cleared).toBe(1);
});

test("点背板关闭，点浮层本身不关", () => {
  const d = doc();
  openPicker({ ...base, options: [{ id: "a", label: "甲" }], onPick: () => {} }, d);
  click(d.querySelector(".sheet"));
  expect(d.querySelector(".sheet-backdrop")).not.toBeNull();
  click(d.querySelector(".sheet-backdrop"));
  expect(d.querySelector(".sheet-backdrop")).toBeNull();
});
