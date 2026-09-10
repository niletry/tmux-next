import { tmux } from "../../src/tmux/run";
import { getListeningPort } from "../../src/listening-port";
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

  // 新建会话页的「会话类型」表单打这条路由，body 形状是那个页面对所有插件
  // 一视同仁的通用信封：{ kind, dir, name, fields }。kind 这里其实用不上——
  // 一个插件的 create-session 路由天然只服务它自己声明过的类型，内核也没有
  // 别的类型会打到这条路径上——但仍然把它当 unknown 收进类型签名，不悄悄
  // 假设调用方一定规矩。
  if (url.pathname === "/api/supervisor/create-session" && req.method === "POST") {
    let body: { dir?: unknown; name?: unknown; fields?: { autoConfirmPermission?: unknown } };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "cwd" }, { status: 400 });
    }
    if (typeof body.dir !== "string" || !body.dir.trim()) {
      return Response.json({ error: "cwd" }, { status: 400 });
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;

    // The port the agent must curl back is the one this process actually
    // bound, never anything derived from the request's Host header — behind
    // the reverse proxy this repo documents, `url.port` is the proxy's port
    // (often empty), and nothing listens there for `/api/notify`.
    const result = await createSupervisor({
      cwd: body.dir,
      name,
      autoConfirmPermission: body.fields?.autoConfirmPermission === true,
      port: String(getListeningPort()),
    });

    if (!result.ok) {
      const status = result.reason === "exists" ? 409 : 422;
      return Response.json({ error: result.reason }, { status });
    }
    return Response.json({ session: result.session }, { status: 201 });
  }

  return null;
}
