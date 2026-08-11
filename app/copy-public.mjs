// Build step: assemble the WebView's www/ from (a) the shell's own files
// (the connection page) and (b) a copy of the tmux-next front-end plus its
// one vendored dependency, xterm.js. The browser loads public/ straight from
// disk with the server serving node_modules; here both must live inside the
// shell, so the two diverge only in how they are served, never in the code.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("www", { recursive: true, force: true });
await mkdir("www", { recursive: true });
await cp("shell", "www", { recursive: true });
await cp("../public", "www/tmux", { recursive: true });
// terminal.html loads xterm from node_modules/; the browser mode gets it from
// the server's module path, the shell must carry it.
await cp("../node_modules/@xterm", "www/node_modules/@xterm", { recursive: true });

// Stamp the front-end build SHA into the connection page, so a phone can tell
// at a glance whether it runs the same front-end as the server.
import { execSync } from "node:child_process";
let sha = "dev";
try {
  sha = execSync("git rev-parse --short HEAD", { cwd: ".." }).toString().trim();
} catch {}
const index = "www/index.html";
await writeFile(index, (await readFile(index, "utf8")).replace("{{BUILD}}", sha));
console.log(`www assembled; frontend build ${sha}`);
