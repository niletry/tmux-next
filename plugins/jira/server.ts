import { readJiraConfig } from "./config";
export { start, source } from "./source";
export { readSettings, writeSettings, runAction } from "./settings";

/**
 * 工单插件的服务端入口。数据源在 source.ts，缓存在 cache.ts，chip 拼装在
 * facets.ts，设置在 settings.ts；这里只剩一条路由。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/jira/config" && req.method === "GET") {
    const config = await readJiraConfig();
    // token 从不出门。url 和 email 出门是为了页面能显示"连的是哪个实例"。
    return Response.json(
      config ? { configured: true, url: config.url, email: config.email } : { configured: false },
    );
  }
  return null;
}
