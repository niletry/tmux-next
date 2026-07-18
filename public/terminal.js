"use strict";

// The tmux window is locked to 80 columns server side, so the browser's job is
// to pick a font size that makes 80 columns fit, and report how many rows fit.
const COLUMNS = 80;

const target = new URLSearchParams(location.search).get("target");
const statusEl = document.getElementById("status");
const termEl = document.getElementById("term");
document.getElementById("title").textContent = target || "";

const term = new Terminal({
  cols: COLUMNS,
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

/** Sizes the font so exactly COLUMNS columns fit, then derives the row count. */
function fit() {
  const width = termEl.clientWidth;
  const height = termEl.clientHeight;
  if (width < 40 || height < 40) return term.rows;

  // Measure the real cell width instead of guessing the aspect ratio.
  const probe = term._core?._renderService?.dimensions?.css?.cell;
  const ratio = probe && probe.width > 0 ? probe.width / term.options.fontSize : 0.6;

  const fontSize = Math.max(6, Math.floor(width / COLUMNS / ratio));
  if (fontSize !== term.options.fontSize) term.options.fontSize = fontSize;

  const cell = term._core?._renderService?.dimensions?.css?.cell;
  const cellHeight = cell && cell.height > 0 ? cell.height : fontSize * 1.2;
  const rows = Math.max(8, Math.floor(height / cellHeight));

  if (rows !== term.rows) term.resize(COLUMNS, rows);
  return rows;
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
    socket.send(JSON.stringify({ t: "open", target, rows: fit() }));
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

term.onData((data) => sendBytes(encoder.encode(data)));

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

termEl.addEventListener("touchend", focusTerminal);

// --- key toolbar -----------------------------------------------------------

let ctrlArmed = false;
const ctrlBtn = document.getElementById("ctrl");

ctrlBtn.addEventListener("click", () => {
  ctrlArmed = !ctrlArmed;
  ctrlBtn.classList.toggle("sticky-on", ctrlArmed);
  focusTerminal();
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
    focusTerminal();
  });
}

// --- viewport --------------------------------------------------------------

function resizeAndNotify() {
  const rows = fit();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ t: "resize", rows }));
  }
}

// iOS raises the soft keyboard by shrinking the visual viewport, not the layout
// viewport, so a window resize event alone never fires.
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeAndNotify);
}
window.addEventListener("resize", resizeAndNotify);
window.addEventListener("orientationchange", () => setTimeout(resizeAndNotify, 300));

fit();
connect();
