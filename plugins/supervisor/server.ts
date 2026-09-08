import { tmux } from "../../src/tmux/run";
import { listLiveSupervisors } from "./state";
import { readPatrolLog } from "./log";
import { createSupervisor } from "./create";

const LOG_LIMIT = 200;

const hasSession = async (session: string) => (await tmux(["has-session", "-t", `=${session}`])).ok;

export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/supervisor" && req.method === "GET") {
    const supervisors = await listLiveSupervisors(hasSession);
    return Response.json({ supervisors });
  }

  if (url.pathname === "/api/supervisor/log" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) return Response.json({ error: "cwd" }, { status: 400 });
    const entries = await readPatrolLog(cwd, LOG_LIMIT);
    return Response.json({ entries });
  }

  if (url.pathname === "/api/supervisor/create" && req.method === "POST") {
    let body: { cwd?: unknown; autoConfirmPermission?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "cwd" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return Response.json({ error: "cwd" }, { status: 400 });
    }

    const result = await createSupervisor({
      cwd: body.cwd,
      autoConfirmPermission: body.autoConfirmPermission === true,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    });

    if (!result.ok) {
      const status = result.reason === "exists" ? 409 : 422;
      return Response.json({ error: result.reason }, { status });
    }
    return Response.json({ session: result.session }, { status: 201 });
  }

  return null;
}
