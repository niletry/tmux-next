import { homedir } from "node:os";
import { allowedRoots, listDirectories, resolveWithinRoots } from "./paths";
import { PaneSession } from "./tmux/pane-session";
import { createSession } from "./tmux/session-create";
import {
  killSession,
  listSessions,
  recentDirectories,
  sessionNames,
} from "./tmux/session-list";
import { reapOrphanWebSessions } from "./tmux/session-manager";

type WsData = { session: PaneSession | null };

type ClientMessage =
  | { t: "open"; target: string; rows: number }
  | { t: "keys"; hex: string }
  | { t: "resize"; rows: number };

/** Reasons the caller can fix, versus ones that mean the request was refused. */
const CREATE_STATUS: Record<string, number> = {
  empty: 400,
  invalid: 400,
  reserved: 400,
  baddir: 400,
  failed: 500,
};

/**
 * Creates or reuses a session, then hands the name back for the client to open.
 *
 * The directory goes through the same root check as browsing: limiting only the
 * listing endpoint would be pointless when a POST could name any path at all.
 */
async function createSessionResponse(req: Request): Promise<Response> {
  let body: { dir?: unknown; name?: unknown };
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

  const dir = await resolveWithinRoots(body.dir, allowedRoots());
  if (!dir.ok) return Response.json({ error: "baddir" }, { status: 400 });

  const result = await createSession(dir.path, body.name, await sessionNames());
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: CREATE_STATUS[result.reason] ?? 400 });
  }

  return Response.json({ name: result.name, created: result.created });
}

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const MODULES_DIR = new URL("../", import.meta.url).pathname;
const REAP_INTERVAL_MS = 60_000;

export function startServer(port: number): { stop(): void; port: number } {
  const server = Bun.serve<WsData, {}>({
    // Loopback only. TLS and auth are Caddy's job.
    hostname: "127.0.0.1",
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

      // Directories the create dialog offers first, most used first. `home` is
      // sent along so the client can abbreviate paths without guessing it.
      if (url.pathname === "/api/directories") {
        return Response.json({ home: homedir(), recent: await recentDirectories() });
      }

      // Browsing for a directory the sessions don't already cover.
      if (url.pathname === "/api/dirs") {
        const roots = allowedRoots();
        const listing = await listDirectories(url.searchParams.get("path") ?? roots[0]!, roots);
        if (!listing.ok) return Response.json({ error: "forbidden" }, { status: 403 });
        return Response.json(listing);
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
            ws.data.session = await PaneSession.open({
              target: msg.target,
              rows: msg.rows,
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

        if (msg.t === "keys") {
          const bytes = Uint8Array.from(
            msg.hex.split(" ").filter(Boolean).map((h) => parseInt(h, 16)),
          );
          await ws.data.session.sendKeys(bytes);
        } else if (msg.t === "resize") {
          await ws.data.session.resize(msg.rows);
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

  return {
    port: server.port,
    stop() {
      clearInterval(reaper);
      server.stop(true);
    },
  };
}
