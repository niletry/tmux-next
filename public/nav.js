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
 * Renders the navigation icons into an existing header.
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
  nav.className = "hnav";
  nav.setAttribute("aria-label", tr("nav.label"));

  for (const tab of TABS) {
    const label = tr(tab.key);
    if (tab.page === current) {
      const here = document.createElement("span");
      here.className = "hnav-item on";
      here.setAttribute("aria-current", "page");
      here.title = label;
      here.innerHTML = svg(ICONS[tab.page]);
      nav.append(here);
    } else {
      const link = document.createElement("a");
      link.className = "hnav-item";
      link.href = tab.href;
      link.title = label;
      link.setAttribute("aria-label", label);
      link.innerHTML = svg(ICONS[tab.page]);
      nav.append(link);
    }
  }
  header.append(nav);
  return nav;
}
