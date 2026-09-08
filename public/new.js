import { filterEntries, splitPath } from "./dir-filter.js";
import { initLang, tr } from "./i18n-apply.js";
import { initTheme } from "./theme-apply.js";
import { icon } from "./icons.js";
import { PLUGINS } from "../plugins/registry.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Same wording as the session list, kept local so the sheet stands alone. */
function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.justNow");
  if (secs < 3600) return tr("list.minutesAgo", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.hoursAgo", { n: Math.floor(secs / 3600) });
  return tr("list.daysAgo", { n: Math.floor(secs / 86400) });
}

const MKDIR_ERRORS = {
  empty: () => tr("mkdir.empty"),
  invalid: () => tr("mkdir.invalid"),
  hidden: () => tr("mkdir.hidden"),
  toolong: () => tr("mkdir.toolong"),
  exists: () => tr("mkdir.exists"),
  badparent: () => tr("mkdir.badparent"),
  failed: () => tr("mkdir.failed"),
};

const ERRORS = {
  baddir: () => tr("create.baddir"),
  empty: () => tr("create.empty"),
  reserved: () => tr("create.reserved"),
  invalid: () => tr("create.invalid"),
  failed: () => tr("create.failed"),
  startfailed: () => tr("create.startfailed"),
};

/**
 * The dialog for starting a new Claude Code session.
 *
 * Two screens, so only one list is ever on screen at a time. The first is the
 * whole of new-session: directory first, name second — nearly every session
 * lives in the same project, so the common path is to accept the default
 * directory and type nothing but a ticket number, or not even that. The second
 * screen is reached only on demand, to resume a past conversation in the chosen
 * directory instead of starting fresh.
 *
 * Browsing is tap-driven rather than typed. Reaching a new directory on a phone
 * by typing its full path is miserable, so the list drills down a level per tap
 * and the field only filters what is already on screen.
 */
export function renderNewSession(root) {
  // The page body stands in for the sheet. Everything below builds the same
  // two screens; what changes is that they are the page rather than a layer
  // over it, so the directory list gets real height and the soft keyboard has
  // somewhere to push.
  const sheet = root;

  // --- screen 1: new session -------------------------------------------------
  const step1 = el("div", "sheet-step");
  step1.append(el("h2", null, tr("new.title")));

  const favourites = el("div", "chips");
  const crumb = el("div", "crumb");
  const filter = el("input", "field");
  filter.placeholder = tr("new.filterDirs");
  filter.autocapitalize = "none";
  filter.autocomplete = "off";

  const list = el("div", "dir-list");

  const nameField = el("input", "field name-field");
  nameField.placeholder = tr("new.namePlaceholder");
  nameField.autocapitalize = "none";
  nameField.autocomplete = "off";

  // 模板：从一张单开会话时，会话名和首条输入长什么样。
  //
  // 只在带 ?item= 时出现——没有单就没有字段，每个占位符都会渲染成空，给一个必然产出
  // 空模板的选择器只是噪音。清单为空时同样不画，所以没建过模板的人看到的是跟以前
  // 一模一样的页面。
  const templateRow = el("div", "template-row");
  const initialField = el("textarea", "field initial");
  initialField.placeholder = tr("new.inputPlaceholder");
  initialField.rows = 4;
  initialField.style.display = "none";
  // 跟 src/template.ts 的 MAX_RENDERED（本身从 send-text.ts 的 MAX_TEXT 推导）对齐：
  // 框里能装的必须等于最终能敲进 pane 的，否则粘一段超长文字进来会在会话建好之后
  // 无声无息地被 sendText 拒收，用户完全看不出为什么什么都没敲进去。
  initialField.maxLength = 2000;
  /** @type {Array<{id:string,label:string,name:string,input:string}>} */
  let templates = [];
  let chosenTemplate = null;

  function drawTemplates() {
    templateRow.replaceChildren();
    if (!itemId || !templates.length) return;
    templateRow.append(el("span", "template-label", tr("new.template")));
    const none = el("button", "template-chip", tr("new.templateNone"));
    none.type = "button";
    if (!chosenTemplate) none.classList.add("on");
    none.addEventListener("click", () => pickTemplate(null));
    templateRow.append(none);
    for (const t of templates) {
      const chip = el("button", "template-chip", t.label);
      chip.type = "button";
      if (chosenTemplate === t.id) chip.classList.add("on");
      chip.addEventListener("click", () => pickTemplate(t));
      templateRow.append(chip);
    }
  }

  /**
   * 换一个模板：两个框都**直接覆盖**，包括手改过的内容。
   *
   * 选模板这个动作的意思就是"改用这一套"，为它加一道确认，是在为一个用户刚刚亲手表达
   * 的意图设障。
   */
  async function pickTemplate(t) {
    chosenTemplate = t ? t.id : null;
    drawTemplates();
    if (!t) {
      initialField.value = "";
      initialField.style.display = "none";
      return;
    }
    initialField.style.display = "";
    try {
      const res = await fetch(`api/items/${encodeURIComponent(itemId)}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: t.name, input: t.input }),
      });
      if (!res.ok) return; // 渲染不出来就让两个框保持原样，模板不是必需品
      const body = await res.json();
      // 落地前再确认一次：这次响应还对应着当前选中的模板吗。连点两个模板时响应可能
      // 乱序回来，晚到的旧响应会把框填成跟高亮对不上的内容；先选模板再点"不用模板"
      // 时，晚到的响应会把已经清空隐藏的输入框又填回来。
      if (chosenTemplate !== t.id) return;
      nameField.value = body.name || "";
      initialField.value = body.input || "";
    } catch {
      // 离线：同上，框里还是原来那些，人照样能自己打字建会话。
    }
  }

  // Deliberately unchecked every time and never remembered: this hands Claude
  // Code the machine without asking again, so it should be a decision made per
  // session rather than a setting that quietly stays on.
  // Which agent to start. Fetched rather than hard-coded so the list and its
  // capabilities stay in step with the server — notably which agents have a
  // skip-permissions mode at all.
  const agentRow = el("div", "agent-row");
  let agents = [{ id: "claude", label: "Claude Code", supportsSkipPermissions: true }];
  let chosenAgent = "claude";

  function drawAgents() {
    agentRow.replaceChildren();
    if (agents.length < 2) return; // nothing to choose between
    for (const a of agents) {
      const btn = el("button", "agent-chip", a.label);
      btn.type = "button";
      if (a.id === chosenAgent) btn.classList.add("on");
      // Not installed, or not on the login shell's PATH: starting it would make
      // a session that disappears immediately, so say so instead of offering it.
      if (a.available === false) {
        btn.classList.add("missing");
        btn.disabled = true;
        btn.title = tr("new.agentMissing", { label: a.label });
      }
      btn.addEventListener("click", () => {
        chosenAgent = a.id;
        drawAgents();
        // The checkbox is meaningless where the agent has no such mode, and a
        // switch that silently does nothing is worse than no switch.
        const supported = agents.find((x) => x.id === chosenAgent)?.supportsSkipPermissions;
        skipRow.style.display = supported ? "" : "none";
        if (!supported) skipBox.checked = false;
      });
      agentRow.append(btn);
    }
  }

  const skipRow = el("label", "check skip-row");
  const skipBox = document.createElement("input");
  skipBox.type = "checkbox";
  skipRow.append(skipBox, el("span", null, tr("new.skipPermissions")));
  skipRow.append(el("b", "check-warn", tr("new.skipWarn")));

  // Shown only when the chosen directory has past conversations; opens screen 2.
  const resumeEntry = el("button", "resume-entry", tr("new.resumeEntry"));
  resumeEntry.style.display = "none";

  // 「会话类型」：内核自带的「普通会话」永远排第一，后面跟着已启用插件在清单里
  // 声明的 sessionKinds（见 plugins/types.ts）。内核不认识这些类型的意思，只
  // 认识"选中一种插件类型时，把下面这一整组普通会话专属的控件收起来，换成插件
  // 自己要的表单"——跟 agentRow 用同一套 chip 交互，只有一种类型可选时（没有
  // 插件声明过）整组都不画，省得给谁都只能选一种时的假选择。
  const kindRow = el("div", "kind-row");
  const kindFieldsRow = el("div", "kind-fields");
  // 普通会话才有意义的东西全部装进一个包裹里：选中插件类型时整个隐藏，选回
  // 「普通会话」时整个露出——子元素各自的显隐逻辑（比如 resumeEntry 只在有历史
  // 时才显示）完全不受影响，包裹只是叠加了一层"这一组现在算不算数"。
  const normalFields = el("div", "normal-fields");
  normalFields.append(templateRow, initialField, agentRow, skipRow, resumeEntry);

  /** 内核自己的「普通会话」选项，跟插件声明的类型共用同一套渲染，但没有 pluginId/fields。 */
  const DEFAULT_KIND = { pluginId: null, key: null, labelKey: "new.kindDefault" };
  /** @type {Array<{pluginId:string,key:string,labelKey:string,hintKey?:string,fields?:Array<{key:string,type:string,labelKey:string,hintKey?:string}>}>} */
  let kindOptions = [];
  let chosenKind = DEFAULT_KIND;
  /** @type {Array<{key:string, read: () => unknown}>} */
  let kindFieldReaders = [];

  function drawKindFields(opt) {
    kindFieldsRow.replaceChildren();
    kindFieldReaders = [];
    if (!opt) return;
    for (const f of opt.fields ?? []) {
      if (f.type === "boolean") {
        const row = el("label", "check kind-field");
        const box = document.createElement("input");
        box.type = "checkbox";
        row.append(box, el("span", null, tr(f.labelKey)));
        if (f.hintKey) row.title = tr(f.hintKey);
        kindFieldsRow.append(row);
        kindFieldReaders.push({ key: f.key, read: () => box.checked });
        continue;
      }
      // 剩下的都当文本类输入处理——目前只有 boolean 真的在用，但字段类型是个开放
      // 集合（跟 SettingField 一样），不认识的类型不该让整页炸掉。
      const wrap = el("label", "settings-field kind-field");
      wrap.append(el("span", "settings-label", tr(f.labelKey)));
      const input = document.createElement("input");
      input.type = f.type === "url" ? "url" : f.type === "secret" ? "password" : "text";
      input.className = "settings-input";
      wrap.append(input);
      if (f.hintKey) wrap.title = tr(f.hintKey);
      kindFieldsRow.append(wrap);
      kindFieldReaders.push({ key: f.key, read: () => input.value });
    }
  }

  function drawKinds() {
    kindRow.replaceChildren();
    if (!kindOptions.length) return; // 没有插件声明过，谈不上"选一种"
    const mkChip = (opt) => {
      const btn = el("button", "kind-chip", tr(opt.labelKey));
      btn.type = "button";
      if (opt === chosenKind) btn.classList.add("on");
      if (opt.hintKey) btn.title = tr(opt.hintKey);
      btn.addEventListener("click", () => selectKind(opt));
      return btn;
    };
    kindRow.append(mkChip(DEFAULT_KIND));
    for (const opt of kindOptions) kindRow.append(mkChip(opt));
  }

  function selectKind(opt) {
    chosenKind = opt;
    drawKinds();
    const isPlugin = opt !== DEFAULT_KIND;
    normalFields.style.display = isPlugin ? "none" : "";
    drawKindFields(isPlugin ? opt : null);
  }

  step1.append(favourites, crumb, filter, list, nameField, kindRow, kindFieldsRow, normalFields);

  // --- screen 2: pick a past conversation ------------------------------------
  const step2 = el("div", "sheet-step");
  step2.style.display = "none";
  const back = el("button", "sheet-back", tr("new.backToHistory"));
  const historyBox = el("div", "history");
  step2.append(back, historyBox);

  // --- shared footer ---------------------------------------------------------
  const error = el("p", "sheet-error");
  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("new.cancel"));
  const submit = el("button", "btn primary", tr("new.create"));
  actions.append(cancel, submit);

  sheet.append(step1, step2, error, actions);


  let home = "";
  let current = null;
  let entries = [];
  // 不叫 history：这个函数里还要用 window.history 改地址栏和后退，同名的局部变量
  // 会把它整个遮掉。曾经就是这样——syncUrl 第一行的 `typeof history?.replaceState`
  // 打在这个数组上恒为假，整个地址栏同步从来没生效过，而两个 history.back() 打在
  // 数组上直接抛。
  let pastRuns = []; // past conversations for `current`
  let busy = false;

  // Leaving is the browser's back, not a close button — the directory you are
  // in is in the URL, so back walks up the path you came down.
  const close = () => history.back();
  cancel.addEventListener("click", close);

  /**
   * Writes the current directory and screen into the address bar.
   *
   * replaceState while browsing down, pushState when switching screens: every
   * directory should be a back step, but re-rendering the same screen should
   * not pile up entries.
   */
  /**
   * A caller-supplied place to go after the session is created.
   *
   * Plugin pages send the user here rather than duplicating this whole page,
   * then need control back to record whatever the session means to them. This
   * is the ordinary `?next=` of any web app, and the kernel stays ignorant of
   * who is asking — it only knows someone left an address.
   *
   * Anything that could leave this origin is refused: a scheme, a
   * protocol-relative `//host`, or a leading `/` that would escape a
   * reverse-proxy subpath mount. What survives can only name a page of this
   * app, resolved the same way every other link here is.
   */
  function safeReturn() {
    const raw = new URLSearchParams(location.search).get("return");
    if (!raw) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/")) return null;
    return raw;
  }

  /**
   * The work item this session was started from, if the caller is a card on
   * the home page (items.js links here as `new.html?item=<id>`). Read once at
   * module scope like `wantName` below — it never changes over the life of
   * this page, only the directory being browsed does.
   */
  const itemId = new URLSearchParams(location.search).get("item");

  function syncUrl(push) {
    // Guarded: history is unavailable in some embedded webviews, and browsers
    // rate-limit these calls. Neither is worth breaking the page over.
    if (typeof history?.replaceState !== "function") return;
    const params = new URLSearchParams();
    if (current) params.set("dir", current);
    if (step === 2) params.set("resume", "1");
    // Carried through directory browsing so a reload mid-flow still knows where
    // it was going and what it was going to be called.
    const incoming = new URLSearchParams(location.search);
    for (const key of ["name", "return"]) {
      const value = incoming.get(key);
      if (value) params.set(key, value);
    }
    // 单号也要带上，否则中途刷新一次就丢了：会话照样建得出来，只是不挂在任何单
    // 下，而首页是按单画的——它会看着像凭空消失。
    //
    // 取模块作用域的 itemId 而不是再从 URL 里读一遍：URL 正是这个函数在改写的
    // 东西，漏带过一次就再也捡不回来；itemId 是进这个页面那一刻定下的，只要页面
    // 还活着它就是对的。
    if (itemId) params.set("item", itemId);
    const url = `new.html?${params}`;
    if (url === location.pathname.slice(1) + location.search) return;
    try {
      if (push) history.pushState({}, "", url);
      else history.replaceState({}, "", url);
    } catch {
      // Rate-limited by the browser; the page is still correct.
    }
  }

  let step = 1;

  function showStep(n) {
    step = n;
    error.textContent = "";
    step1.style.display = n === 1 ? "" : "none";
    step2.style.display = n === 2 ? "" : "none";
    actions.style.display = n === 1 ? "" : "none";
  }

  /**
   * Whether what is typed in the filter could be a new directory's name.
   *
   * Mirrors the server's validateDirName. Duplicated rather than shared because
   * this only decides whether to *offer* the action — the server re-checks and
   * is the authority. Keeping it in step matters for the offer looking sane,
   * not for safety.
   */
  function offerableName(raw) {
    const name = raw.trim();
    if (!name || name === "." || name === "..") return null;
    if (name.includes("/") || name.includes("\\")) return null;
    if (name.startsWith(".") || name.length > 255) return null;
    return name;
  }

  /**
   * Creates the typed directory inside the one being browsed, then enters it.
   *
   * The name comes from the filter box because that is where it already is: by
   * the time someone sees "no matching directory" they have typed the name they
   * wanted. Asking for it again in a dialog would be asking twice.
   */
  async function createDir(name) {
    error.textContent = "";
    let res;
    try {
      res = await fetch("api/dirs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: current, name }),
      });
    } catch {
      error.textContent = tr("new.offline");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.textContent = (MKDIR_ERRORS[body.error]?.() ) ?? tr("new.mkdirFailed");
      return;
    }
    const { path } = await res.json();
    filter.value = "";
    await browse(path);
  }

  function drawList() {
    const matches = filterEntries(entries, filter.value);
    if (!matches.length) {
      const typed = offerableName(filter.value);
      if (typed) {
        const make = el("button", "dir-make");
        const plusMark = el("span", "dir-make-plus");
        plusMark.innerHTML = icon("plus", 14);
        make.append(plusMark, el("span", null, tr("new.makeHere", { name: typed })));
        make.addEventListener("click", () => createDir(typed));
        list.replaceChildren(make);
        return;
      }
      list.replaceChildren(el("p", "dir-empty", tr(entries.length ? "new.noMatch" : "new.noSubdirs")));
      return;
    }
    list.replaceChildren(
      ...matches.map((entry) => {
        const row = el("button", "dir-row", entry.name);
        row.addEventListener("click", () => browse(entry.path));
        return row;
      }),
    );
  }

  function drawCrumb(parent) {
    crumb.replaceChildren();
    if (parent) {
      const up = el("button", "up", tr("new.parentDir"));
      up.addEventListener("click", () => browse(parent));
      crumb.append(up);
    }
    // `lead`, not `parent`: the enclosing parameter already holds the path the
    // up button navigates to, which is a different thing from the dimmed text.
    const { parent: lead, leaf } = splitPath(current, home);
    const path = el("span", "crumb-path");
    if (lead) path.append(el("span", "crumb-lead", lead));
    path.append(el("span", "crumb-leaf", leaf));
    crumb.append(path);
  }

  async function browse(path) {
    error.textContent = "";
    let res;
    try {
      res = await fetch(`api/dirs?path=${encodeURIComponent(path)}`);
    } catch {
      error.textContent = tr("new.offline");
      return;
    }
    if (!res.ok) {
      // "not there" and "not allowed" are different answers; a privacy block on
      // an external volume used to read as an ordinary empty folder.
      const body = await res.json().catch(() => ({}));
      error.textContent = tr(body.error === "denied" ? "new.dirDenied" : "new.dirForbidden");
      return;
    }
    const body = await res.json();
    current = body.path;
    entries = body.entries;
    // A fresh level starts unfiltered; the old query rarely matches here.
    filter.value = "";
    drawCrumb(body.parent);
    drawList();
    markFavourite();
    // Not awaited: the directory shows at once, the resume entry appears if the
    // directory turns out to have history.
    refreshHistory(current);

    // Last, and never fatal. The address bar is a convenience — being able to
    // go back a level and to keep a directory's link. Rendering the directory
    // is the job. Putting this mid-function once meant a throw here left the
    // list, the breadcrumb and the favourites all unrendered.
    syncUrl();
  }

  // Fetches the directory's past conversations so screen 2 can show them, and
  // reveals the entry button only when there is something to resume.
  async function refreshHistory(dir) {
    pastRuns = [];
    resumeEntry.style.display = "none";
    let conversations;
    try {
      const res = await fetch(`api/history?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) return; // history is optional; a failure just hides the entry
      ({ conversations } = await res.json());
    } catch {
      return;
    }
    // A later browse() may have moved on while this was in flight.
    if (dir !== current || !conversations || !conversations.length) return;
    pastRuns = conversations;
    resumeEntry.textContent = tr("new.resumeEntryCount", { n: pastRuns.length });
    resumeEntry.style.display = "";
  }

  function renderHistory() {
    historyBox.replaceChildren();
    for (const c of pastRuns) {
      const row = el("button", "hist-row");
      row.append(el("span", "hist-title", c.title || c.id.slice(0, 8)));
      row.append(el("span", "hist-time", relativeTime(c.mtime)));
      row.addEventListener("click", () => create(c.id, row));
      historyBox.append(row);
    }
  }

  function markFavourite() {
    for (const chip of favourites.children) {
      chip.classList.toggle("on", chip.dataset.path === current);
    }
  }

  // 建成之后要做的事，普通会话和插件会话类型共用：能绑就绑上这张单，然后导航
  // 过去。两条创建路径唯一不同的是怎么把会话建出来，建出来之后"落地"的意义
  // 完全一样——重复这一段迟早会有一条路径漏掉绑定或者导航目标写错。
  async function afterCreated(name) {
    // Bind before navigating away, but never let a failed bind strand the
    // user on this form — the session already exists and is what they
    // asked for. Uses the name the server actually gave it (it
    // de-duplicates), not whatever was typed into the name field.
    if (itemId) {
      try {
        const bindRes = await fetch(`api/items/${encodeURIComponent(itemId)}/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: name }),
        });
        if (!bindRes.ok) {
          // 单不存在、会话没起来——两种都只是没绑上，会话本身照常可用，
          // 静默退化成"建了但没归单"，不拦导航。
        }
      } catch {
        // 离线/网络抖动同上：不拦导航。
      }
    }

    const back = safeReturn();
    if (back) {
      // The caller gets the created name appended to whatever it asked for,
      // and decides itself where the user ends up.
      const sep = back.includes("?") ? "&" : "?";
      location.href = `${back}${sep}created=${encodeURIComponent(name)}`;
      return;
    }
    location.href = `terminal.html?target=${encodeURIComponent(name)}`;
  }

  // The one create path, for both a fresh session and a resumed one. `resume`
  // is a conversation id or null; the directory, name, and skip choice come
  // from screen 1 either way.
  async function create(resume, trigger) {
    if (!current || busy) return;
    busy = true;
    const label = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = tr(resume ? "new.resuming" : "new.creating");
    error.textContent = "";

    const name = nameField.value.trim();
    const payload = { dir: current };
    if (name) payload.name = name;
    // Only ever sent as true; the server treats anything else as off anyway.
    if (skipBox.checked) payload.skipPermissions = true;
    if (chosenAgent !== "claude") payload.agent = chosenAgent;
    if (resume) payload.resume = resume;
    // 发出去的是框里**最终**那段文字，不是模板：用户改过的那一版才是他要发的。
    const initial = initialField.value.trim();
    if (initial) payload.initialInput = initial;

    try {
      const res = await fetch("api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error.textContent = (ERRORS[body.error]?.()) ?? tr("new.createFailed");
        busy = false;
        trigger.disabled = false;
        trigger.textContent = label;
        return;
      }
      const body = await res.json();
      await afterCreated(body.name);
    } catch {
      error.textContent = tr("new.offline");
      busy = false;
      trigger.disabled = false;
      trigger.textContent = label;
    }
  }

  // 插件声明的会话类型走的创建路径：目录/会话名照旧从屏幕 1 取，其余(agent、
  // 跳过权限、恢复历史、模板)对插件类型没有意义所以不带；插件自己要的字段来自
  // kindFieldReaders。`/api/<id>/*` 已经会把请求分发到那个插件的 handle()，
  // 不需要内核再开一条路由——这条 fetch 打的地址本身就是"点名"这件事发生的
  // 唯一一处，且点的是**用户选中的那个插件**，不是内核写死的名字。
  async function createPluginKind(trigger) {
    if (!current || busy) return;
    const opt = chosenKind;
    busy = true;
    const label = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = tr("new.creating");
    error.textContent = "";

    const fields = {};
    for (const r of kindFieldReaders) fields[r.key] = r.read();
    const name = nameField.value.trim();
    const payload = { kind: opt.key, dir: current, fields };
    if (name) payload.name = name;

    try {
      const res = await fetch(`api/${opt.pluginId}/create-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // 409 是这条路径特有的、值得单独说一句的失败——"这个目录已经有一个了"
        // 是用户能采取行动的信息（换个目录，或者去找那个已经在跑的）；内核不
        // 知道、也不该知道插件把这件事叫做什么，所以这句话是内核自己的通用
        // 文案，不是插件的错误码翻出来的。
        error.textContent = res.status === 409 ? tr("new.kindExists") : tr("new.createFailed");
        busy = false;
        trigger.disabled = false;
        trigger.textContent = label;
        return;
      }
      const body = await res.json();
      await afterCreated(body.session);
    } catch {
      error.textContent = tr("new.offline");
      busy = false;
      trigger.disabled = false;
      trigger.textContent = label;
    }
  }

  filter.addEventListener("input", drawList);
  submit.addEventListener("click", () => {
    if (chosenKind !== DEFAULT_KIND) createPluginKind(submit);
    else create(null, submit);
  });
  resumeEntry.addEventListener("click", () => {
    renderHistory();
    showStep(2);
    syncUrl(true);
  });
  back.addEventListener("click", () => history.back());

  // Populate: favourites drive the default directory, so they load first.
  (async () => {
    // Not awaited together with the directories: an older server without this
    // endpoint should still give a working sheet with Claude Code only.
    fetch("api/agents")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.agents?.length) {
          agents = body.agents;
          const current = agents.find((a) => a.id === chosenAgent);
          if (current && current.available === false) {
            chosenAgent = (agents.find((a) => a.available !== false) || agents[0]).id;
          }
          drawAgents();
        }
      })
      .catch(() => {});

    // 会话类型：哪些插件启用了，只有服务端知道（TMUX_NEXT_DISABLE_PLUGINS），
    // 而每个插件声明了什么类型只有同构的 registry.js 知道——跟 item-card.js
    // 的 claimedProviders() 是同一步棋，取两边的交集。问不到就当没人声明过，
    // 页面照旧只有「普通会话」，不是一个卡住的空转轮。
    fetch("api/plugins")
      .then((r) => (r.ok ? r.json() : null))
      .then((ids) => {
        if (!Array.isArray(ids)) return;
        const enabled = new Set(ids);
        kindOptions = [];
        for (const p of PLUGINS) {
          if (!enabled.has(p.id)) continue;
          for (const k of p.sessionKinds ?? []) kindOptions.push({ pluginId: p.id, ...k });
        }
        drawKinds();
      })
      .catch(() => {});

    // 只在带 ?item= 时问：没有单就不会画选择器，那一发请求纯属浪费。
    if (itemId) {
      fetch("api/templates")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (body?.templates?.length) {
            templates = body.templates;
            drawTemplates();
          }
        })
        .catch(() => {});
    }

    let dirs = [];
    try {
      const body = await (await fetch("api/directories")).json();
      home = body.home;
      dirs = body.recent;
    } catch {
      error.textContent = tr("new.offline");
      return;
    }

    const fromUrl = new URLSearchParams(location.search).get("dir");
    if (fromUrl) dirs = [fromUrl, ...dirs.filter((d) => d !== fromUrl)];

    favourites.replaceChildren(
      ...dirs.slice(0, 6).map((path) => {
        const chip = el("button", "chip", path.slice(path.lastIndexOf("/") + 1) || path);
        chip.dataset.path = path;
        chip.title = path;
        chip.addEventListener("click", () => browse(path));
        return chip;
      }),
    );

    // With no sessions yet there is nothing to rank, so start from home.
    if (dirs[0] ?? home) await browse(dirs[0] ?? home);
  
  // The address bar is the source of truth on load: opening
  // new.html?dir=/some/path lands there directly, and back/forward move
  // between the directories visited rather than leaving the page.
  // A caller may propose a name; the field stays editable, so this is a default
  // rather than a decision.
  const wantName = new URLSearchParams(location.search).get("name");
  if (wantName) nameField.value = wantName;

  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    const want = params.get("dir");
    showStep(params.get("resume") === "1" ? 2 : 1);
    if (want && want !== current) browse(want);
  });
})();
}


// --- page entry --------------------------------------------------------------

initTheme();
initLang().then(() => {
  renderNewSession(/** @type {HTMLElement} */ (document.getElementById("new")));
});
