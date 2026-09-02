// @ts-check
/**
 * 一个从底部升起的单选浮层：给一列候选，选中一个就回调。
 *
 * 两个方向共用同一个组件——首页的单要挂一个已有会话，会话列表的会话要挂到一张单
 * 下。两边是同一件事的两种说法，画两套只会让它们慢慢长歪。
 *
 * 刻意不认识 i18n：文案全部由调用方传进来。这样它没有字典依赖，测试里不必先把
 * 语言环境搭起来，也不必为它新增一批只有它用的键。
 */

/**
 * @typedef {object} PickOption
 * @property {string} id 回调里拿到的值
 * @property {string} label 主文字
 * @property {string} [note] 次要说明，灰色显示在右边（比如"已挂在某单下"）
 * @property {boolean} [current] 是不是当前已选中的那个
 */

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {PickOption[]} opts.options
 * @param {string} opts.emptyText 一个候选都没有时显示的话
 * @param {string} opts.cancelText
 * @param {string} opts.failedText 回调抛了之后显示的话
 * @param {(id: string) => Promise<void> | void} opts.onPick
 * @param {{ label: string, onPick: () => Promise<void> | void }} [opts.clear]
 *   额外的一个"解除"动作，只有当前已经挂着东西时才传。
 * @param {Document} [doc] 测试用；默认当前文档
 * @returns {HTMLElement} 背板元素，调用方一般不需要它
 */
export function openPicker(opts, doc = document) {
  const backdrop = doc.createElement("div");
  backdrop.className = "sheet-backdrop";
  const sheet = doc.createElement("div");
  sheet.className = "sheet";

  const title = doc.createElement("h2");
  title.textContent = opts.title;
  sheet.append(title);

  const err = doc.createElement("p");
  err.className = "sheet-error";
  err.hidden = true;
  sheet.append(err);

  const close = () => backdrop.remove();

  if (!opts.options.length) {
    const empty = doc.createElement("p");
    empty.className = "sheet-warn";
    empty.textContent = opts.emptyText;
    sheet.append(empty);
  } else {
    const list = doc.createElement("div");
    list.className = "pick-list";
    for (const option of opts.options) {
      const row = doc.createElement("button");
      row.type = "button";
      // current 的那一行仍然可以点：再点一次是无操作，但把它藏起来会让人以为
      // 自己记错了当前挂在哪。标出来比拿掉好。
      row.className = option.current ? "pick-row current" : "pick-row";
      row.dataset.id = option.id;

      const label = doc.createElement("span");
      label.className = "pick-label";
      label.textContent = option.label;
      row.append(label);

      if (option.note) {
        const note = doc.createElement("span");
        note.className = "pick-note";
        note.textContent = option.note;
        row.append(note);
      }

      row.addEventListener("click", () => run(() => opts.onPick(option.id)));
      list.append(row);
    }
    sheet.append(list);
  }

  const actions = doc.createElement("div");
  actions.className = "sheet-actions";

  if (opts.clear) {
    const clear = doc.createElement("button");
    clear.type = "button";
    clear.className = "btn danger";
    clear.textContent = opts.clear.label;
    clear.addEventListener("click", () => run(() => /** @type {NonNullable<typeof opts.clear>} */ (opts.clear).onPick()));
    actions.append(clear);
  }

  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = opts.cancelText;
  cancel.addEventListener("click", close);
  actions.append(cancel);
  sheet.append(actions);

  let busy = false;
  /** @param {() => Promise<void> | void} action */
  async function run(action) {
    if (busy) return;
    busy = true;
    setDisabled(true);
    err.hidden = true;
    try {
      await action();
      close();
    } catch {
      // 浮层留着：失败之后把人扔回列表，他既不知道成没成，也得重新找一遍。
      err.textContent = opts.failedText;
      err.hidden = false;
      busy = false;
      setDisabled(false);
    }
  }

  /** @param {boolean} on */
  function setDisabled(on) {
    for (const b of sheet.querySelectorAll("button")) {
      /** @type {HTMLButtonElement} */ (b).disabled = on;
    }
    cancel.disabled = false; // 取消永远按得动，卡住时也能退出去
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.append(sheet);
  doc.body.append(backdrop);
  return backdrop;
}
