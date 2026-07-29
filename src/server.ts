import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { sanitiseGeometry } from "./geometry";
import { imageExtension, uploadName, UPLOAD_DIR, MAX_UPLOAD_BYTES } from "./upload";
import { recordUsage, readUsage } from "./key-usage";
import { listGallery, galleryFilePath } from "./gallery";
import { listDirectories, resolveDirectory } from "./paths";
import { PaneSession } from "./tmux/pane-session";
import { createSession, launchCommand } from "./tmux/session-create";
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
const CREATE_STATUS: Record<string, number> = {
  empty: 400,
  invalid: 400,
  reserved: 400,
  baddir: 400,
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
  let body: { dir?: unknown; name?: unknown; skipPermissions?: unknown };
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

  const dir = await resolveDirectory(body.dir);
  if (!dir.ok) return Response.json({ error: "baddir" }, { status: 400 });

  const result = await createSession(
    dir.path,
    body.name,
    await sessionNames(),
    launchCommand(body.skipPermissions),
  );
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

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const MODULES_DIR = new URL("../", import.meta.url).pathname;
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

      // The drop-folder gallery: what is in it, and its files one by one. The
      // name is reduced to a basename inside the gallery, so it can never reach
      // a file elsewhere on disk. Content types come from Bun.file by extension,
      // which is what lets the client render images and HTML.
      if (url.pathname === "/api/gallery" && req.method === "GET") {
        return Response.json(await listGallery());
      }
      if (url.pathname === "/api/gallery/file" && req.method === "GET") {
        const path = galleryFilePath(url.searchParams.get("name") ?? "");
        if (!path) return new Response("bad name", { status: 400 });
        const file = Bun.file(path);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file);
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

      // Browsing for a directory the sessions don't already cover. Any path on
      // the machine is fair game; a failure here means it is missing or not a
      // directory, not that it was off limits.
      if (url.pathname === "/api/dirs") {
        const listing = await listDirectories(url.searchParams.get("path") ?? homedir());
        if (!listing.ok) return Response.json({ error: "notfound" }, { status: 404 });
        return Response.json(listing);
      }

      const rename = url.pathname.match(/^\/api\/sessions\/(.+)\/rename$/);
      if (rename && req.method === "POST") {
        return renameResponse(req, decodeURIComponent(rename[1]!));
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

      // xterm.js ships as ES modules; serve them straight from node_modules.
      if (url.pathname.startsWith("/node_modules/")) {
        const mod = Bun.file(MODULES_DIR + url.pathname.slice(1));
        if (await mod.exists()) return new Response(mod);
      }

      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const asset = Bun.file(PUBLIC_DIR + name);
      if (await asset.exists()) return new Response(asset);

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
