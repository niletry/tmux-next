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

/** @typedef {"sessions" | "gallery" | "notifications"} Page */

const ICONS = {
  gallery:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  notifications:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
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

/** Order in the header, left to right. */
const TABS = /** @type {{ page: Page, href: string, key: string }[]} */ ([
  { page: "sessions", href: "./", key: "list.title" },
  { page: "gallery", href: "gallery.html", key: "gallery.title" },
  { page: "notifications", href: "notifications.html", key: "notif.title" },
]);

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
export function renderNav(header, current) {
  const nav = document.createElement("nav");
  nav.className = "hseg";
  nav.setAttribute("aria-label", tr("nav.label"));

  for (const tab of TABS) {
    const label = tr(tab.key);
    const active = tab.page === current;
    const node = document.createElement(active ? "span" : "a");
    node.className = active ? "hseg-item on" : "hseg-item";
    if (active) {
      node.setAttribute("aria-current", "page");
    } else {
      /** @type {HTMLAnchorElement} */ (node).href = tab.href;
    }

    node.innerHTML = svg(ICONS[tab.page]);
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
