"use strict";

import { createGesture, createPager } from "./scroll-gesture.js";

import { MIN_COLUMNS, computeGeometry } from "./terminal-fit.js";
import { createCopyGate, decodeOsc52 } from "./copy-on-select.js";

const target = new URLSearchParams(location.search).get("target");
const statusEl = document.getElementById("status");
const termEl = document.getElementById("term");
document.getElementById("title").textContent = target || "";
// The tab title too, not just the in-page bar: with several sessions open the
// tab strip is the only thing that tells them apart, and "tmux" repeated four
// times tells you nothing. Home-screen bookmarks pick this up as well.
document.title = target || "tmux";

const term = new Terminal({
  // Starting grid only; fit() replaces both before the socket opens.
  cols: MIN_COLUMNS,
  rows: 24,
  scrollback: 5000,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  theme: { background: "#14161a", foreground: "#e6e8ec" },
  allowProposedApi: true,
});
term.open(termEl);

try {
  term.loadAddon(new WebglAddon.WebglAddon());
} catch (e) {
  // Falls back to the DOM renderer; not fatal.
  console.warn("webgl renderer unavailable", e);
}

// --- select to copy --------------------------------------------------------

/** Writes text to the system clipboard, flashing the result in the status bar. */
function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(
    () => flashStatus("已复制"),
    () => flashStatus("复制失败：需要 HTTPS"),
  );
}

/**
 * Two paths reach the same clipboard write, one per way a selection is made.
 *
 * When mouse reporting is off, or with Shift held, xterm owns the selection and
 * onSelectionChange fires. When a program has mouse reporting on (Claude Code
 * does), a plain drag is handled by tmux instead, which answers by sending the
 * selection as an OSC 52 sequence — xterm normally drops it, so we register a
 * handler and route it to the same place. Between them, both plain-drag and
 * Shift-drag copy for real.
 *
 * The two never fire for one gesture: a drag either reaches xterm's selection
 * or tmux's, not both. The gate still guards against xterm's repeated
 * selection-change events during a single drag.
 */
const copyGate = createCopyGate();

term.onSelectionChange(() => {
  const text = term.getSelection();
  if (copyGate.shouldCopy(text)) copyToClipboard(text);
});

term.parser.registerOscHandler(52, (data) => {
  const text = decodeOsc52(data);
  if (text) copyToClipboard(text);
  // Returning true marks it handled, so xterm does not fall through to its own
  // OSC 52 behaviour or log an unhandled sequence.
  return true;
});

let statusResetTimer = null;
function flashStatus(message) {
  const previous = statusEl.textContent;
  statusEl.textContent = message;
  if (statusResetTimer) clearTimeout(statusResetTimer);
  statusResetTimer = setTimeout(() => {
    // Only restore if nothing else changed it in the meantime.
    if (statusEl.textContent === message) statusEl.textContent = previous;
  }, 1500);
}

/** Height of one row in CSS pixels, falling back before the renderer reports. */
function cellHeight() {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  return cell && cell.height > 0 ? cell.height : term.options.fontSize * 1.2;
}

/** Picks a font size and grid that fill the element, and reports the geometry. */
function fit() {
  const width = termEl.clientWidth;
  const height = termEl.clientHeight;
  if (width < 40 || height < 40) return { cols: term.cols, rows: term.rows };

  // Measure the real cell width instead of guessing the aspect ratio.
  const probe = term._core?._renderService?.dimensions?.css?.cell;
  const ratio = probe && probe.width > 0 ? probe.width / term.options.fontSize : 0.6;

  const { cols, rows, fontSize } = computeGeometry({
    width,
    height,
    ratio,
    lineHeight: cellHeight() / term.options.fontSize,
  });

  if (fontSize !== term.options.fontSize) term.options.fontSize = fontSize;
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  return { cols, rows };
}

let socket = null;
let reconnectDelay = 500;

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const base = location.pathname.replace(/[^/]*$/, "");
  return `${scheme}://${location.host}${base}ws`;
}

function connect() {
  statusEl.textContent = "连接中…";
  socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    statusEl.textContent = "已连接";
    reconnectDelay = 500;
    const { cols, rows } = fit();
    socket.send(JSON.stringify({ t: "open", target, rows, cols }));
    // A reconnect rebuilds the screen; keep the keyboard up if it was up.
    restoreFocusSoon();
  };

  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.t === "error") statusEl.textContent = "错误: " + msg.message;
  };

  socket.onclose = () => {
    statusEl.textContent = "已断开，重连中…";
    // Nothing is buffered across connections: the server rebuilds the screen
    // from capture-pane on every open, so a reconnect is a full redraw.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

const encoder = new TextEncoder();

function sendBytes(bytes) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  let hex = "";
  for (const b of bytes) hex += (hex ? " " : "") + b.toString(16).padStart(2, "0");
  socket.send(JSON.stringify({ t: "keys", hex }));
}

// Records what xterm just emitted so the IME fallback below can tell whether a
// given `input` event was already handled. xterm dispatches onData
// synchronously from its own input handler, which runs before ours.
let lastSent = { data: "", at: -Infinity };
// Bumped on every emission, which lets the scroll code below detect whether a
// synthetic wheel event actually produced a mouse sequence.
let sendCount = 0;

function send(data) {
  lastSent = { data, at: performance.now() };
  sendCount++;
  sendBytes(encoder.encode(data));
}

term.onData(send);

/**
 * Recovers IME text that xterm 5.5.0 drops on the floor.
 *
 * Its `_inputEvent` guard reads `(!e.composed || !this._keyDownSeen)`, and
 * `composed` is always true for input events, so it degrades to
 * `!_keyDownSeen`: any insertion preceded by a keydown is discarded. Chinese
 * punctuation lands exactly there — pressing `,` under a pinyin IME fires a
 * keydown (keyCode 229) that produces no data, then commits `，` through an
 * input event that the guard then throws away. Han characters survive because
 * they arrive via compositionend, and ASCII survives because keydown emits it
 * directly; only the punctuation vanishes.
 *
 * Anything xterm did handle already reached `send` synchronously, so matching
 * against `lastSent` keeps this from double-sending.
 */
if (term.textarea) {
  term.textarea.addEventListener("input", (e) => {
    if (e.inputType !== "insertText" || !e.data || e.isComposing) return;
    if (e.data === lastSent.data && performance.now() - lastSent.at < 30) return;
    send(e.data);
    // xterm normally drains the textarea itself; it never saw this one.
    term.textarea.value = "";
  });
}

// --- soft keyboard ---------------------------------------------------------

/**
 * xterm's own textarea is the single input path.
 *
 * An earlier version routed typing through a separate offscreen input to raise
 * the iOS keyboard. That broke IME input badly: the `input` event fires on
 * every composition update, so typing pinyin sent "s", "sh", "shu", "shu r"…
 * as separate keystrokes before the composed characters. xterm's textarea
 * already handles composition and emits only the final text through onData,
 * and focusing it inside a touch handler raises the keyboard just as well.
 */
function focusTerminal() {
  term.focus();
}

/**
 * Whether the user wants the soft keyboard up.
 *
 * iOS hides the keyboard the moment the textarea loses focus, and a tap on any
 * button or bar steals it. Rather than chase each case, the page tracks intent
 * and restores focus whenever something took it away — except when the user
 * asked for it to go away.
 */
const kbdBtn = document.getElementById("kbd");
let keyboardWanted = false;

function openKeyboard() {
  keyboardWanted = true;
  focusTerminal();
  kbdBtn.classList.add("sticky-on");
}

function closeKeyboard() {
  keyboardWanted = false;
  term.blur();
  kbdBtn.classList.remove("sticky-on");
}

termEl.addEventListener("mousedown", openKeyboard);

// --- scrolling --------------------------------------------------------------

/**
 * Drags scroll the *program*, not a scrollback buffer.
 *
 * tmux repaints the whole screen in place and never lets a line fall off the
 * top, so xterm's scrollback is permanently empty and its native touch
 * scrolling has nothing to move. Full-screen programs (Claude Code, vim, less)
 * keep their history to themselves, so the only way to reach it is to hand them
 * a scroll they understand.
 *
 * Synthesising a WheelEvent rather than writing escape bytes lets xterm encode
 * it in whatever mouse protocol the program negotiated. It also fails safely:
 * xterm only binds a wheel listener while a program asks for mouse reporting,
 * so a program that ignores the mouse produces no output at all rather than
 * having stray bytes dumped into it — which is exactly the signal the PgUp
 * fallback keys off.
 */
const PAGE_UP = new Uint8Array([0x1b, 0x5b, 0x35, 0x7e]);
const PAGE_DOWN = new Uint8Array([0x1b, 0x5b, 0x36, 0x7e]);

/** Sends one line of wheel and reports whether the program took it. */
function wheelLine(up) {
  const before = sendCount;
  (term.element || termEl).dispatchEvent(
    new WheelEvent("wheel", {
      // Whole lines: xterm drops a wheel event whose delta rounds to zero rows,
      // and pixel deltas have to survive a line-height division to get there.
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: up ? -1 : 1,
      bubbles: true,
      cancelable: true,
    })
  );
  return sendCount !== before;
}

function scrollLines(lines) {
  const up = lines > 0;
  let refused = 0;
  for (let i = 0; i < Math.abs(lines); i++) {
    if (!wheelLine(up)) refused++;
  }
  if (!refused) return;

  // The program ignores the mouse; page keys are the next best thing, but one
  // per line would jump a page per line, so they accumulate into whole pages.
  const pages = pager.take(up ? refused : -refused);
  for (let i = 0; i < Math.abs(pages); i++) {
    sendBytes(pages > 0 ? PAGE_UP : PAGE_DOWN);
  }
}

let gesture = null;
let pager = null;

termEl.addEventListener(
  "touchstart",
  (e) => {
    // Multi-touch is a pinch or a system gesture; leave it alone.
    if (e.touches.length !== 1) {
      gesture = null;
      return;
    }
    gesture = createGesture({ lineHeight: cellHeight() });
    pager = createPager({ pageLines: Math.max(1, term.rows - 2) });
    gesture.start(e.touches[0].clientY);
  },
  { passive: true }
);

termEl.addEventListener(
  "touchmove",
  (e) => {
    if (!gesture || e.touches.length !== 1) return;
    const lines = gesture.move(e.touches[0].clientY);
    if (!lines) return;
    // Not passive: without this Safari rubber-bands the page instead.
    e.preventDefault();
    scrollLines(lines);
  },
  { passive: false }
);

// Only a tap raises the keyboard — a swipe used to raise it on every scroll.
termEl.addEventListener("touchend", () => {
  const tapped = gesture && gesture.end().tap;
  gesture = null;
  if (tapped) openKeyboard();
});

// Restoring focus inside the blur handler itself is ignored by Safari, so it
// has to be deferred to the next task.
function restoreFocusSoon() {
  if (!keyboardWanted) return;
  setTimeout(() => {
    if (keyboardWanted) focusTerminal();
  }, 0);
}

// Any tap on the page chrome must not count as leaving the terminal.
for (const chrome of document.querySelectorAll(".keys, .term-bar")) {
  chrome.addEventListener("pointerdown", (e) => {
    // The back link is a real navigation; let it through.
    if (e.target.closest("a")) return;
    e.preventDefault();
  });
}

if (term.textarea) {
  term.textarea.addEventListener("blur", restoreFocusSoon);
}

// --- key toolbar -----------------------------------------------------------

let ctrlArmed = false;
const ctrlBtn = document.getElementById("ctrl");

// pointerdown throughout the toolbar: the container cancels the default
// action to protect focus, which would also swallow a later click event.
ctrlBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  ctrlArmed = !ctrlArmed;
  ctrlBtn.classList.toggle("sticky-on", ctrlArmed);
  if (keyboardWanted) focusTerminal();
});

kbdBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (keyboardWanted) closeKeyboard();
  else openKeyboard();
});

function disarmCtrl() {
  ctrlArmed = false;
  ctrlBtn.classList.remove("sticky-on");
}

// Ctrl is sticky: tap it, then tap a letter to send the control character.
function interceptCtrl(e) {
  if (!ctrlArmed || e.type !== "keydown" || e.key.length !== 1) return true;
  const code = e.key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    sendBytes(new Uint8Array([code - 64]));
    disarmCtrl();
    e.preventDefault();
    return false;
  }
  return true;
}

term.attachCustomKeyEventHandler(interceptCtrl);

for (const btn of document.querySelectorAll(".keys button[data-hex]")) {
  // pointerdown, not click: clicking would blur the terminal and drop the
  // soft keyboard between every toolbar tap.
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const bytes = btn.dataset.hex.split(" ").map((h) => parseInt(h, 16));
    sendBytes(new Uint8Array(bytes));
    if (keyboardWanted) focusTerminal();
  });
}

// --- viewport --------------------------------------------------------------

/** Pins the layout to the visual viewport so the keyboard actually shrinks us. */
function syncAppHeight() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  // iOS also scrolls the layout viewport under the keyboard; undo that so the
  // bar and key row stay on screen.
  if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
}

function resizeAndNotify() {
  syncAppHeight();
  const { cols, rows } = fit();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ t: "resize", rows, cols }));
  }
}

// iOS raises the soft keyboard by shrinking the visual viewport, not the layout
// viewport, so a window resize event alone never fires.
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeAndNotify);
  window.visualViewport.addEventListener("scroll", syncAppHeight);
}
window.addEventListener("resize", resizeAndNotify);
window.addEventListener("orientationchange", () => setTimeout(resizeAndNotify, 300));

syncAppHeight();
fit();
connect();
