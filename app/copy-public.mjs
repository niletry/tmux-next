// Build step: copy the tmux-next front-end into the WebView's www/.
// The browser loads public/ straight from disk; here it must live inside the
// shell, so the two diverge only in how they are served, never in the code.
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

await rm("www/tmux", { recursive: true, force: true });
await mkdir("www", { recursive: true });
await cp("../public", "www/tmux", { recursive: true });
console.log("copied ../public -> www/tmux");
