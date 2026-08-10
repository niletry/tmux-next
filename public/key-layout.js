// @ts-check
/**
 * Virtual-keyboard layout: which toolbar keys sit in which row, and in what
 * order.
 *
 * Stored per device (localStorage), like font size: how the keys sit on the
 * screen you are holding is a property of that screen, not of the machine.
 * The default order mirrors the markup in terminal.html.
 */

/** Stable identifiers for every user-orderable key, grouped by row. */
/** @type {{ primary: string[], nav: string[], tools: string[] }} */
export const ROWS = {
  primary: ["esc", "tab", "shift-tab", "up", "down", "enter"],
  nav: ["ctrl", "ctrl-c", "left", "right"],
  tools: ["kbd", "mic", "img", "paste", "copy", "font-dec", "font-inc"],
};

/** The one key that never moves: the ▴ that expands the rest of the bar. */
export const TOGGLE = "toggle";

const ALL = new Set([...ROWS.primary, ...ROWS.nav, ...ROWS.tools]);

/**
 * data-key → the usage label the toolbar reports taps under.
 *
 * Mostly the same string, except where the toolbar's own names differ (the
 * keyboard toggle reports as "keyboard", the mic as "voice", the font
 * buttons as "font-smaller"/"font-bigger"). The editor shows these counts so
 * the order can be chosen from evidence instead of guesswork.
 */
export const USAGE_OF = /** @type {const} */ ({
  esc: "esc",
  tab: "tab",
  "shift-tab": "shift-tab",
  up: "up",
  down: "down",
  enter: "enter",
  ctrl: "ctrl",
  "ctrl-c": "ctrl-c",
  left: "left",
  right: "right",
  kbd: "keyboard",
  mic: "voice",
  img: "image",
  paste: "paste",
  copy: "copy",
  "font-dec": "font-smaller",
  "font-inc": "font-bigger",
});

const STORAGE_KEY = "termKeys";

/**
 * The layout when nothing has been configured, or when what is stored cannot
 * be trusted. A fresh object every call so callers can mutate freely.
 */
export function defaultLayout() {
  return {
    primary: [...ROWS.primary],
    nav: [...ROWS.nav],
    tools: [...ROWS.tools],
  };
}

/**
 * Turns whatever came out of localStorage into a usable layout.
 *
 * Nothing is taken on faith: unknown keys are dropped, duplicates collapse,
 * and a key that is missing from the stored rows is appended to its home row
 * in default order — so a version that adds a new key (the mic appeared this
 * way) still shows it, while a hand-edited or stale value cannot produce a
 * broken toolbar. Anything that is not an object at all is the default.
 *
 * @param {unknown} raw
 * @returns {{ primary: string[], nav: string[], tools: string[] }}
 */
export function normaliseLayout(raw) {
  const out = defaultLayout();
  if (!raw || typeof raw !== "object") return out;
  const obj = /** @type {Record<string, unknown>} */ (raw);

  /** @type {Set<string>} */
  const seen = new Set();
  for (const row of /** @type {(keyof typeof ROWS)[]} */ (["primary", "nav", "tools"])) {
    const stored = obj[row];
    const kept = [];
    if (Array.isArray(stored)) {
      for (const k of stored) {
        if (typeof k === "string" && ALL.has(k) && !seen.has(k)) {
          kept.push(k);
          seen.add(k);
        }
      }
    }
    // Whatever the stored row was missing, restore in default order.
    for (const k of ROWS[row]) {
      if (!seen.has(k)) {
        kept.push(k);
        seen.add(k);
      }
    }
    out[row] = kept;
  }
  return out;
}

/** Reads the stored layout, falling back to the default on any problem. */
export function readLayout() {
  try {
    return normaliseLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return defaultLayout();
  }
}

/** Stores a layout. Returns false if the device refused (private mode etc.). */
/** @param {{ primary: string[], nav: string[], tools: string[] }} layout */
export function writeLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normaliseLayout(layout)));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the stored layout, returning the toolbar to the default order. */
export function clearLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do if storage is unavailable */
  }
}
