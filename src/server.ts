import { PaneSession } from "./tmux/pane-session";
import { listSessions } from "./tmux/session-list";
import { reapOrphanWebSessions } from "./tmux/session-manager";

type WsData = { session: PaneSession | null };

type ClientMessage =
  | { t: "open"; target: string; rows: number }
  | { t: "keys"; hex: string }
  | { t: "resize"; rows: number };

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

      if (url.pathname === "/api/sessions") {
        return Response.json(await listSessions());
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
