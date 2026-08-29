// @ts-check
/**
 * The header shared by the list, gallery and notification pages.
 *
 * Those three are siblings, but the markup treated the list as the hub: it
 * carried the icons and the other two carried a back link, so getting from
 * artifacts to notifications meant going through the list, and nothing on the
 * page said which one you were looking at.
 *
 * Built here rather than repeated in three HTML files — the icons alone are
 * several hundred bytes of SVG each, and three copies drift.
 */

import { tr } from "./i18n-apply.js";
import { PLUGINS } from "../plugins/registry.js";
import { url } from "./root.js";

/** @typedef {string} Page "sessions"，或某个插件 id（见 plugins/registry.js）。 */

const ICONS = {
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 ' +
    '1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 ' +
    '0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 ' +
    '0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 ' +
    '0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 ' +
    '2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  sessions:
    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>' +
    '<line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.2"/>' +
    '<circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>',
};

function svg(/** @type {string} */ paths) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

/**
 * 启用的插件 id。服务端才读得到 TMUX_NEXT_DISABLE_PLUGINS，所以问它一次。
 *
 * 问不到就当全开：默认就是全开，而"服务暂时答不上来"跟"用户关掉了它"是两回
 * 事，把后者的表现给前者，等于离线时功能凭空消失。
 */
async function enabledIds() {
  try {
    const res = await fetch(url("api/plugins"));
    if (!res.ok) throw new Error(String(res.status));
    const ids = await res.json();
    if (Array.isArray(ids)) return ids;
  } catch {
    // 落到下面的默认
  }
  return PLUGINS.map((p) => p.id);
}

/**
 * Renders the page switcher into an existing header.
 *
 * A segmented control of icons: the grouping is what says these three are
 * alternatives to each other, which a scattered row of icons does not. Labels
 * are carried by title/aria-label rather than shown, so the control stays
 * narrow enough to leave the header to the page's own actions.
 *
 * The count moves inside the active segment: there is no page title any more
 * for it to sit beside, and a second line for one number is not worth it.
 *
 * Only the active segment carries a count. Showing all three would mean
 * fetching two other pages' totals on every load to fill in numbers nobody
 * asked for.
 *
 * The current page becomes a `span` rather than a link: a link to where you
 * already are does nothing when tapped, and giving it `aria-current` while
 * leaving it clickable tells screen readers one thing and the finger another.
 *
 * @param {HTMLElement} header
 * @param {Page} current
 */
export async function renderNav(header, current) {
  const on = new Set(await enabledIds());
  const tabs = [
    { page: "sessions", href: url("./"), key: "list.title", icon: ICONS.sessions },
    ...PLUGINS.filter((p) => on.has(p.id)).map((p) => ({
      page: p.id,
      href: url(`p/${p.id}/`),
      key: p.titleKey,
      icon: p.icon,
    })),
  ];

  const nav = document.createElement("nav");
  nav.className = "hseg";
  nav.setAttribute("aria-label", tr("nav.label"));

  for (const tab of tabs) {
    const label = tr(tab.key);
    const active = tab.page === current;
    const node = document.createElement(active ? "span" : "a");
    node.className = active ? "hseg-item on" : "hseg-item";
    if (active) {
      node.setAttribute("aria-current", "page");
    } else {
      /** @type {HTMLAnchorElement} */ (node).href = tab.href;
    }

    node.innerHTML = svg(tab.icon);
    // Icons only, so the accessible name is the only thing naming this tab —
    // it is not decoration here, it is the label.
    node.title = label;
    node.setAttribute("aria-label", label);

    // The count element keeps its id so each page's script can keep writing to
    // it without knowing it moved in here.
    if (active) {
      const count = document.createElement("span");
      count.className = "count";
      count.id = "count";
      node.append(count);
    }
    nav.append(node);
  }
  header.prepend(nav);
  return nav;
}

/**
 * The whole header: page switcher on the left, actions on the right.
 *
 * One component rather than markup repeated per page. The actions are global
 * — notification subscription, language and theme, starting a session — so
 * they belong wherever you are, not only on the list.
 *
 * Behaviour is wired here too. Leaving each page to bind its own buttons is
 * how the three headers drifted apart in the first place.
 *
 * @param {Page} current
 */
export async function renderHeader(current) {
  const header = /** @type {HTMLElement} */ (document.getElementById("header"));
  if (!header) return;

  await renderNav(header, current);

  const actions = document.createElement("div");
  actions.className = "hactions";

  const bell = document.createElement("button");
  bell.className = "hbell";
  bell.id = "notify-toggle";
  bell.innerHTML = svg(ICONS.bell);
  actions.append(bell);

  const gear = document.createElement("button");
  gear.className = "hbell";
  gear.innerHTML = svg(ICONS.gear);
  gear.title = tr("list.settings");
  gear.setAttribute("aria-label", tr("list.settings"));
  actions.append(gear);

  const plus = document.createElement("button");
  plus.className = "new";
  plus.textContent = "＋";
  plus.title = tr("list.newSession");
  plus.setAttribute("aria-label", tr("list.newSession"));
  actions.append(plus);

  header.append(actions);

  // Imported here rather than at the top so a page that only needs the switcher
  // does not pull the sheets in, and so nav.js stays free of import cycles.
  // New session is its own page now, so this is a link's job, not a sheet's:
  // browsing directories needs real height, the soft keyboard needs somewhere
  // to push, and back should walk up the path rather than discard it.
  plus.addEventListener("click", () => {
    location.href = url("new.html");
  });

  const [{ initNotifyToggle }, { openThemeSheet }] = await Promise.all([
    import("./push.js"),
    import("./theme-sheet.js"),
  ]);
  gear.addEventListener("click", openThemeSheet);
  initNotifyToggle(bell);
}
