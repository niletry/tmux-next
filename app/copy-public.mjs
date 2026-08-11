// Build step: assemble the WebView's www/ from (a) the shell's own files
// (the connection page) and (b) a copy of the tmux-next front-end plus its
// one vendored dependency, xterm.js. The browser loads public/ straight from
// disk with the server serving node_modules; here both must live inside the
// shell, so the two diverge only in how they are served, never in the code.
import { cp, mkdir, rm } from "node:fs/promises";

await rm("www", { recursive: true, force: true });
await mkdir("www", { recursive: true });
await cp("shell", "www", { recursive: true });
await cp("../public", "www/tmux", { recursive: true });
// terminal.html loads xterm from node_modules/; the browser mode gets it from
// the server's module path, the shell must carry it.
await cp("../node_modules/@xterm", "www/node_modules/@xterm", { recursive: true });
console.log("www assembled: shell + ../public -> www/tmux + xterm");
