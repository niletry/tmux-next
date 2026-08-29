import { readNotifications } from "../../src/notifications";

/**
 * 发出去的通知留一份日志，手机上划掉的那条还能在网页里翻到。
 *
 * 日志由推送管线写（src/push.ts），这里只读——所以那个模块留在 src/，不搬进来。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/notifications" && req.method === "GET") {
    return Response.json({ notifications: await readNotifications() });
  }
  return null;
}
