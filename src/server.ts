import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { sanitiseGeometry } from "./geometry";
import { imageExtension, uploadName, UPLOAD_DIR, MAX_UPLOAD_BYTES } from "./upload";
import { saveSessionUpload, MAX_SESSION_UPLOAD_BYTES } from "./upload-file";
import { recordUsage, readUsage } from "./key-usage";
import { HANDLERS, enabledPlugins } from "../plugins/handlers";
import { safeBasename } from "./safe-name";
import { setPin } from "./pins";
import { readSessionRecords, restorable, restoreRecord } from "./claude-sessions";
import { createDirectory, listDirectories, resolveDirectory } from "./paths";
import { PaneSession } from "./tmux/pane-session";
import { createSession, launchCommand, resumeCommand } from "./tmux/session-create";
import { listHistory } from "./claude-history";
import { getVapid, saveSubscription, validSubscription, notify, type PushEvent } from "./push";
import { readTheme, writeTheme } from "./theme";
import { themeOf } from "../public/themes.js";
import { readAsrConfig, transcribe } from "./asr";
import { resolveLanguage, writeLanguage } from "./language";
import { AGENT_IDS, AGENTS, isKnownAgent } from "./agents";
import { agentAvailability } from "./agents/availability";
import pkg from "../package.json" with { type: "json" };
import {
  killSession,
  listSessions,
  recentDirectories,
  renameSession,
  sessionNames,
} from "./tmux/session-list";
import { reapOrphanWebSessions } from "./tmux/session-manager";

type WsData = { session: PaneSession | null };

/**
 * Dimensions are typed as unknown on purpose: they arrive as untrusted JSON and
 * must go through sanitiseGeometry before reaching a tmux command.
 */
type ClientMessage =
  | { t: "open"; target: string; rows: unknown; cols?: unknown }
  | { t: "keys"; hex: string }
  | { t: "resize"; rows: unknown; cols?: unknown };

/** Reasons the caller can fix, versus ones that mean the request was refused. */
const PUSH_EVENTS = new Set<PushEvent>(["waiting", "ended", "attention"]);

/** Loopback source, in the forms Bun reports it (incl. IPv4-mapped IPv6). */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const CREATE_STATUS: Record<string, number> = {
  empty: 400,
  invalid: 400,
  reserved: 400,
  baddir: 400,
  failed: 500,
  startfailed: 500,
};

const CREATE_AGENT_STATUS = 400;

const MKDIR_STATUS: Record<string, number> = {
  badparent: 404,
  exists: 409,
  failed: 500,
};

const RENAME_STATUS: Record<string, number> = {
  empty: 400,
  invalid: 400,
  reserved: 400,
  internal: 403,
  missing: 404,
  taken: 409,
  failed: 500,
};

/**
 * Creates or reuses a session, then hands the name back for the client to open.
 *
 * The directory is resolved the same way browsing resolves one, so a session
 * starts in the canonical path rather than in whatever `..` and symlinks the
 * caller happened to send.
 */
async function createSessionResponse(req: Request): Promise<Response> {
  let body: {
    dir?: unknown;
    name?: unknown;
    skipPermissions?: unknown;
    resume?: unknown;
    agent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  if (typeof body.dir !== "string") {
    return Response.json({ error: "baddir" }, { status: 400 });
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  // Absent means the default. Present means it must name an agent we ship —
  // the value is only ever used as a table key, never spliced into a command,
  // and an unknown one is refused rather than quietly falling back.
  if (body.agent !== undefined && !isKnownAgent(body.agent)) {
    return Response.json({ error: "badagent" }, { status: 400 });
  }

  // Resuming a past conversation swaps the launch command for `claude --resume
  // <id>`. The id is validated to id-safe characters before it can reach the
  // shell; a bad one is rejected rather than quietly started as a fresh session.
  let command: string;
  if (body.resume !== undefined) {
    const resumed = resumeCommand(body.resume, body.skipPermissions, body.agent);
    if (resumed === null) return Response.json({ error: "invalid" }, { status: 400 });
    command = resumed;
  } else {
    command = launchCommand(body.skipPermissions, body.agent);
  }

  const dir = await resolveDirectory(body.dir);
  if (!dir.ok) return Response.json({ error: "baddir" }, { status: 400 });

  const result = await createSession(dir.path, body.name, await sessionNames(), command);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: CREATE_STATUS[result.reason] ?? 400 });
  }

  return Response.json({ name: result.name, created: result.created });
}

/** Renames a session in place; the client reconnects under the returned name. */
async function renameResponse(req: Request, from: string): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  if (typeof body.name !== "string") {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const result = await renameSession(from, body.name);
  if (result.ok) return Response.json({ name: result.name });
  return Response.json({ error: result.reason }, { status: RENAME_STATUS[result.reason] ?? 400 });
}

/**
 * Takes an image the browser posted and lands it on disk, so the tool running
 * in the session can be handed a path to look at.
 *
 * The terminal is a byte stream; you cannot paste a picture into it. What you
 * can do is save the picture and type its path, which is exactly how the CLIs
 * people run here consume an image. Everything about the write is fixed by the
 * server — the directory, the name, the accepted types, the size — so a caller
 * cannot steer it into writing arbitrary content to an arbitrary place.
 */
async function uploadResponse(req: Request): Promise<Response> {
  const ext = imageExtension(req.headers.get("content-type") ?? "");
  if (!ext) return Response.json({ error: "type" }, { status: 415 });

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return Response.json({ error: "empty" }, { status: 400 });
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "toobig" }, { status: 413 });
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const path = join(UPLOAD_DIR, uploadName(ext));
  await Bun.write(path, body);
  return Response.json({ path });
}

/**
 * Not a duration limit — voice input deliberately has none. This only stops a
 * broken client from making the server read something unbounded into memory; at
 * opus bitrates it is well over an hour of speech.
 */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const PLUGINS_DIR = new URL("../plugins/", import.meta.url).pathname;
const MODULES_DIR = new URL("../", import.meta.url).pathname;

// A build marker so a phone can see at a glance whether it has the latest
// front-end rather than guessing at the cache. The git short SHA changes every
// deploy; falls back to empty where git isn't available (a published package).
const BUILD: string = (() => {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: MODULES_DIR });
    if (p.exitCode === 0) return new TextDecoder().decode(p.stdout).trim();
  } catch {
    // not a git checkout — leave it empty
  }
  return "";
})();
const REAP_INTERVAL_MS = 60_000;

export function startServer(
  port: number,
  hostname: string = "127.0.0.1",
): { stop(): void; port: number } {
  // Only the WebSocket data type is named. The second parameter is the union
  // of declared route paths, and this server dispatches inside fetch() rather
  // than declaring routes, so its default of `never` is correct.
  const server = Bun.serve<WsData>({
    // Loopback by default: this service has no auth of its own, and expects a
    // reverse proxy in front to provide TLS and authentication.
    hostname,
    port,
    idleTimeout: 120,

    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { session: null } })) return undefined as never;
        return new Response("expected websocket", { status: 400 });
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        return Response.json(await listSessions());
      }

      if (url.pathname === "/api/sessions" && req.method === "POST") {
        return createSessionResponse(req);
      }

      // An image the browser is handing off so the tool in the session can see
      // it. We save it and reply with a path the client then types in.
      if (url.pathname === "/api/upload" && req.method === "POST") {
        return uploadResponse(req);
      }

      // Any file, dropped into the session's own working directory — the image
      // endpoint saves to a fixed dir; this one goes where the user is working.
      // The reply is the absolute path, which the client types back into the
      // prompt so the tool in the session can read the file.
      if (url.pathname === "/api/upload-file" && req.method === "POST") {
        // Reject by declared length before buffering, so an oversized body never
        // reaches formData() at all; the check after parsing still guards.
        const declared = Number(req.headers.get("content-length") ?? "0");
        if (declared > MAX_SESSION_UPLOAD_BYTES) {
          return new Response("too big", { status: 413 });
        }
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          return new Response("bad form", { status: 400 });
        }
        const file = form.get("file");
        const session = form.get("session");
        if (!(file instanceof File) || typeof session !== "string" || session.length === 0) {
          return new Response("missing field", { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength === 0) return new Response("empty", { status: 400 });
        if (bytes.byteLength > MAX_SESSION_UPLOAD_BYTES) {
          return new Response("too big", { status: 413 });
        }
        const result = await saveSessionUpload(session, file.name, bytes);
        if (!result.ok) {
          const status = result.reason === "name" ? 400 : 404;
          return new Response(result.reason, { status });
        }
        return Response.json({ path: result.path });
      }

      // Claude conversations whose tmux session died (a reboot, a crash) but
      // whose record on disk survives — offer to recreate them and resume.
      if (url.pathname === "/api/restorable" && req.method === "GET") {
        const [records, names] = await Promise.all([readSessionRecords(), sessionNames()]);
        return Response.json(
          restorable(records, new Set(names)).map((r) => ({
            session: r.session,
            id: r.id,
            cwd: r.cwd ?? null,
          })),
        );
      }
      if (url.pathname === "/api/restore" && req.method === "POST") {
        let body: { sessions?: unknown } = {};
        try {
          body = await req.json();
        } catch {
          // no body → restore everything restorable
        }
        const [records, names] = await Promise.all([readSessionRecords(), sessionNames()]);
        let list = restorable(records, new Set(names));
        if (Array.isArray(body.sessions)) {
          const want = new Set(body.sessions.filter((s): s is string => typeof s === "string"));
          list = list.filter((r) => want.has(r.session));
        }
        const results = [];
        for (const rec of list) results.push(await restoreRecord(rec));
        return Response.json({ restored: results.filter((r) => r.ok).length, results });
      }

      // Which toolbar keys get tapped, so their order can follow the evidence.
      // The client batches taps and beacons them here; GET reads the totals back.
      if (url.pathname === "/api/key-usage") {
        if (req.method === "GET") return Response.json(await readUsage());
        if (req.method === "POST") {
          try {
            const body = (await req.json()) as { counts?: unknown };
            await recordUsage((body?.counts ?? {}) as Record<string, number>);
          } catch {
            // A malformed beacon is not worth an error; there is nothing to fix.
          }
          return new Response(null, { status: 204 });
        }
      }

      // Directories the create dialog offers first, most used first. `home` is
      // sent along so the client can abbreviate paths without guessing it.
      if (url.pathname === "/api/directories") {
        return Response.json({ home: homedir(), recent: await recentDirectories() });
      }

      // Past Claude conversations in a directory, so a new session can resume
      // one instead of starting fresh. Scoped to the directory because
      // `claude --resume` is; an empty list is a normal answer, not an error.
      if (url.pathname === "/api/history") {
        const dir = await resolveDirectory(url.searchParams.get("dir") ?? "");
        if (!dir.ok) return Response.json({ error: "baddir" }, { status: 400 });
        return Response.json({ conversations: await listHistory(dir.path) });
      }

      // The running version + build, so the front-end can show which it is.
      if (url.pathname === "/api/version") {
        return Response.json(
          { version: pkg.version, build: BUILD },
          { headers: { "Cache-Control": "no-cache" } },
        );
      }

      // What can be started, for the new-session picker. Capabilities travel
      // with each entry so the client does not have to know which agent has
      // which — notably a skip-permissions mode, which only Claude Code has.
      if (url.pathname === "/api/agents" && req.method === "GET") {
        // Availability is probed through a login shell, the same way a launch
        // resolves the command — an agent the server can see but the login
        // shell cannot would otherwise produce a session that vanishes.
        const available = await agentAvailability();
        return Response.json({
          agents: AGENT_IDS.map((id) => ({
            available: available[id] === true,
            id,
            label: AGENTS[id]!.label,
            supportsSkipPermissions: AGENTS[id]!.supportsSkipPermissions,
            supportsResume: AGENTS[id]!.resume !== undefined,
          })),
        });
      }

      // The interface language. GET resolves rather than merely reads: on a
      // machine where nothing has been chosen yet it guesses from the browser
      // and stores that, so someone arriving from npm gets a first screen they
      // can read without touching a setting.
      if (url.pathname === "/api/language" && req.method === "GET") {
        const lang = await resolveLanguage(req.headers.get("accept-language") ?? undefined);
        return Response.json({ lang });
      }
      if (url.pathname === "/api/language" && req.method === "POST") {
        let body: { lang?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        if (!(await writeLanguage(body.lang))) {
          return Response.json({ error: "unknown" }, { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // The colour theme this machine uses. The name only — the colours
      // themselves are in public/themes.js, which the browser imports directly.
      if (url.pathname === "/api/theme" && req.method === "GET") {
        return Response.json({ name: await readTheme() });
      }
      if (url.pathname === "/api/theme" && req.method === "POST") {
        let body: { name?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        if (!(await writeTheme(body.name))) {
          return Response.json({ error: "unknown" }, { status: 400 });
        }
        return new Response(null, { status: 204 });
      }

      // Voice input. Off unless a key is configured, and the browser asks first
      // so a microphone button that could only ever fail is never drawn.
      if (url.pathname === "/api/asr" && req.method === "GET") {
        return Response.json({ enabled: (await readAsrConfig()) !== null });
      }
      if (url.pathname === "/api/asr" && req.method === "POST") {
        const config = await readAsrConfig();
        if (!config) return Response.json({ error: "unconfigured" }, { status: 404 });

        const audio = await req.arrayBuffer();
        if (audio.byteLength > MAX_AUDIO_BYTES) {
          return Response.json({ error: "toobig" }, { status: 413 });
        }
        // The recording goes straight upstream and is dropped. It is more
        // sensitive than anything else this server handles, and keeping a copy
        // would buy nothing.
        const result = await transcribe(audio, config, crypto.randomUUID());
        if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
        return Response.json({ text: result.text });
      }

      // The VAPID public key the browser needs to subscribe for push.
      if (url.pathname === "/api/push/key" && req.method === "GET") {
        return Response.json({ key: (await getVapid()).publicKey });
      }

      // A browser registering (or re-registering) for push notifications.
      if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        if (!validSubscription(body)) return Response.json({ error: "invalid" }, { status: 400 });
        await saveSubscription(body);
        return new Response(null, { status: 204 });
      }

      // A Claude hook reporting an event to notify about. Loopback only: the
      // hooks run on this machine, and — since the server may be bound to
      // 0.0.0.0 — without this guard anyone on the network could spoof
      // notifications. The whole point is that this is not a public endpoint.
      if (url.pathname === "/api/notify" && req.method === "POST") {
        if (!isLoopback(srv.requestIP(req)?.address)) {
          return new Response("forbidden", { status: 403 });
        }
        let body: { event?: unknown; session?: unknown; message?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        if (!PUSH_EVENTS.has(body.event as PushEvent) || typeof body.session !== "string" || !body.session) {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        const message = typeof body.message === "string" ? body.message : undefined;
        const result = await notify(body.event as PushEvent, body.session, { message });
        return Response.json(result, { status: 202 });
      }

      // Browsing for a directory the sessions don't already cover. Any path on
      // the machine is fair game; a failure here means it is missing or not a
      // directory, not that it was off limits.
      if (url.pathname === "/api/dirs" && req.method === "GET") {
        const listing = await listDirectories(url.searchParams.get("path") ?? homedir());
        if (!listing.ok) {
          // A directory that exists but refuses to be read is a different
          // answer from one that is not there, and the browser says so.
          const status = listing.reason === "denied" ? 403 : 404;
          return Response.json({ error: listing.reason }, { status });
        }
        return Response.json(listing);
      }

      // Creating one directory inside the one being browsed, so a session can
      // start somewhere that does not exist yet. Deliberately not `mkdir -p`:
      // the name is validated as a name, and createDirectory then confirms the
      // joined path still sits directly under the resolved parent.
      //
      // This is not a wider door than the app already is. Anyone who reaches
      // the interface can attach to a session and run mkdir themselves; what
      // this adds is a strict subset of that — one level, no delete, no rename.
      if (url.pathname === "/api/dirs" && req.method === "POST") {
        let body: { parent?: unknown; name?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        if (typeof body.parent !== "string") {
          return Response.json({ error: "badparent" }, { status: 400 });
        }
        const result = await createDirectory(body.parent, body.name);
        if (result.ok) return Response.json({ path: result.path }, { status: 201 });
        return Response.json({ error: result.reason }, { status: MKDIR_STATUS[result.reason] ?? 400 });
      }

      const rename = url.pathname.match(/^\/api\/sessions\/(.+)\/rename$/);
      if (rename && req.method === "POST") {
        return renameResponse(req, decodeURIComponent(rename[1]!));
      }

      // Pin or unpin a session so it sits at the top of the list.
      const pin = url.pathname.match(/^\/api\/sessions\/(.+)\/pin$/);
      if (pin && req.method === "POST") {
        let body: { pinned?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid" }, { status: 400 });
        }
        // Strict `=== true`: the value is untrusted JSON.
        await setPin(decodeURIComponent(pin[1]!), body.pinned === true);
        return new Response(null, { status: 204 });
      }

      const kill = url.pathname.match(/^\/api\/sessions\/(.+)$/);
      if (kill && req.method === "DELETE") {
        const name = decodeURIComponent(kill[1]!);
        const result = await killSession(name);
        if (result.ok) return new Response(null, { status: 204 });
        return Response.json(
          { error: result.reason },
          { status: result.reason === "missing" ? 404 : 403 },
        );
      }

      // The web app manifest, without which Android cannot install this as an
      // app: "add to home screen" leaves a browser shortcut, and a tapped
      // notification then has no app to launch. iOS gets a standalone app from
      // apple-mobile-web-app-capable alone, which is why only Android suffered.
      //
      // Generated rather than a static file so its colours come from themes.js
      // like every other colour in the project. A hard-coded manifest would be
      // the one palette themes.test.ts cannot see, and it would go stale the
      // moment the machine's theme changed.
      if (url.pathname === "/manifest.webmanifest") {
        const theme = themeOf(await readTheme());
        return new Response(
          JSON.stringify({
            name: "tmux-next",
            short_name: "tmux",
            description: "A phone-friendly window onto the tmux sessions on this machine.",
            start_url: "./",
            scope: "./",
            display: "standalone",
            orientation: "any",
            background_color: theme.background,
            theme_color: theme.background,
            icons: [
              { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
              { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
              {
                src: "icon-maskable-512.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
              // Follows the theme, so it must not be held past a theme change.
              "Cache-Control": "no-cache",
            },
          },
        );
      }

      // 前端要知道启用了哪些插件才能画顶栏。必须在插件分发**之前**判，
      // 否则一个叫 plugins 的插件能把它盖掉（registry.test.ts 禁掉了这个 id）。
      if (url.pathname === "/api/plugins" && req.method === "GET") {
        return Response.json(enabledPlugins().map((p) => p.id));
      }

      // 插件的 API，各自挂在自己的前缀下。前缀由这里校验，插件只管自己认的
      // 子路径；返回 null 就继续往下走到 404，而不是被它吞掉。
      for (const p of enabledPlugins()) {
        if (url.pathname === `/api/${p.id}` || url.pathname.startsWith(`/api/${p.id}/`)) {
          const res = await HANDLERS[p.id]?.(req, url);
          if (res) return res;
        }
      }

      // xterm.js ships as ES modules; serve them straight from node_modules.
      if (url.pathname.startsWith("/node_modules/")) {
        const mod = Bun.file(MODULES_DIR + url.pathname.slice(1));
        if (await mod.exists()) return new Response(mod);
      }

      // 同构清单：i18n.js 和 nav.js 都要 import 它，而静态资源只从 public/ 出。
      // 只放这两种精确形状，不是把 plugins/ 整个目录挂出去。
      // 不按启用过滤：字典是全量合并的，禁用的插件也得取得到清单。
      if (url.pathname === "/plugins/registry.js") {
        return new Response(Bun.file(PLUGINS_DIR + "registry.js"), {
          headers: { "content-type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      const manifest = url.pathname.match(/^\/plugins\/([a-z][a-z0-9-]*)\/plugin\.js$/);
      if (manifest) {
        const file = Bun.file(`${PLUGINS_DIR}${manifest[1]}/plugin.js`);
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }

      // 插件页面。/p/<id>/ 而不是 /<id>/：一级路径迟早跟 public/ 里的文件或
      // 未来的 API 撞名。禁用的插件，页面跟着 API 一起消失。
      const page = url.pathname.match(/^\/p\/([a-z][a-z0-9-]*)\/(.*)$/);
      if (page) {
        const [, id, rest] = page;
        if (!enabledPlugins().some((p) => p.id === id)) {
          return new Response("not found", { status: 404 });
        }
        const file = rest === "" ? "index.html" : rest!;
        // 跟制品库文件名同一套收窄函数：插件目录同样不能被 ../ 爬出去。浏览器
        // 会先规范化，裸客户端不会。
        if (!safeBasename(file)) {
          return new Response("bad name", { status: 400 });
        }
        const asset = Bun.file(`${PLUGINS_DIR}${id}/public/${file}`);
        if (await asset.exists()) {
          return new Response(asset, { headers: { "Cache-Control": "no-cache" } });
        }
        return new Response("not found", { status: 404 });
      }

      // 搬家前的地址。手机上存了书签、装了 PWA 的人不该撞 404。
      // 相对的 location，子路径部署下同样成立。
      if (url.pathname === "/gallery.html") {
        return new Response(null, { status: 301, headers: { Location: "p/gallery/" } });
      }
      if (url.pathname === "/notifications.html") {
        return new Response(null, { status: 301, headers: { Location: "p/notifications/" } });
      }

      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const asset = Bun.file(PUBLIC_DIR + name);
      if (await asset.exists()) {
        // These files are served straight from disk and change on deploy; a
        // phone (especially an installed PWA) otherwise clings to a stale copy
        // for days. `no-cache` means "revalidate before use", not "don't
        // store", so a redeploy is picked up on the next load.
        return new Response(asset, { headers: { "Cache-Control": "no-cache" } });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      async message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.t === "open") {
          await ws.data.session?.close();
          ws.data.session = null;
          try {
            const { cols, rows } = sanitiseGeometry(msg.cols, msg.rows);
            ws.data.session = await PaneSession.open({
              target: msg.target,
              rows,
              cols,
              // The tmux side went away — the server was replaced, or someone
              // killed the session elsewhere. Closing tells the page, whose
              // reconnect loop then rebuilds from capture-pane. Left open, the
              // page shows "connected" over a socket that is finished.
              onExit: () => {
                ws.data.session = null;
                ws.close();
              },
              onData: (chunk) => {
                ws.send(chunk);
              },
            });
          } catch (e) {
            ws.send(JSON.stringify({ t: "error", message: String(e) }));
          }
          return;
        }

        if (!ws.data.session) return;

        // Belt and braces. PaneSession already swallows the close race, but an
        // unhandled rejection anywhere in here takes the whole server down for
        // every other connection — too high a price for one bad message.
        try {
          if (msg.t === "keys") {
            const bytes = Uint8Array.from(
              msg.hex.split(" ").filter(Boolean).map((h) => parseInt(h, 16)),
            );
            await ws.data.session.sendKeys(bytes);
          } else if (msg.t === "resize") {
            const { cols, rows } = sanitiseGeometry(msg.cols, msg.rows);
            await ws.data.session.resize(rows, cols);
          }
        } catch (e) {
          console.error("websocket message failed", e);
        }
      },

      async close(ws) {
        await ws.data.session?.close();
        ws.data.session = null;
      },
    },
  });

  // Collect anything a previous run left behind, then keep sweeping: the
  // explicit close never runs if we are SIGKILLed.
  void reapOrphanWebSessions();
  const reaper = setInterval(() => {
    void reapOrphanWebSessions();
  }, REAP_INTERVAL_MS);

  // Bun types `port` as optional because a unix-socket server has none. This
  // one always binds TCP, and callers rely on the value — passing port 0 and
  // reading back the one the OS chose is how the tests get a free port — so an
  // absent port is a broken listener, not a case to paper over.
  if (server.port === undefined) {
    clearInterval(reaper);
    server.stop(true);
    throw new Error("server did not bind a TCP port");
  }
  const boundPort = server.port;

  return {
    port: boundPort,
    stop() {
      clearInterval(reaper);
      server.stop(true);
    },
  };
}
