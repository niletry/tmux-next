/**
 * The wire format the agent-side extensions speak.
 *
 * Claude Code's hooks are external shell scripts, so their copy of this lives
 * in `hooks/*.sh`. opencode and pi instead load JS modules into the agent
 * process, and those cannot call into this package — they are copied to the
 * user's extension directory and run there. What they *can* share is this: one
 * tested definition of the URL and the bodies, so a typo in one extension does
 * not silently produce notifications that never arrive.
 *
 * Everything here is pure. The extensions do the fetch themselves, because how
 * they background it differs (opencode has Bun's `$`, pi has plain fetch).
 */

const DEFAULT_PORT = 7682;
const EVENTS = new Set(["waiting", "ended", "attention"]);

/** tmux-next's own mount points, which are never user sessions. */
const WEB_PREFIX = "web-";

/**
 * The endpoint, honouring TMUX_NEXT_PORT.
 *
 * Host is fixed: `/api/notify` is loopback-only by design, and letting an
 * environment variable redirect it would turn a convenience into a way to leak
 * session names off the machine. Only the port is configurable, and only when
 * it parses as one.
 */
export function notifyUrl(port: string | undefined): string {
  const parsed = Number(port);
  const usable = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  return `http://127.0.0.1:${usable}/api/notify`;
}

function usableSession(session: unknown): string | null {
  if (typeof session !== "string") return null;
  const name = session.trim();
  if (!name || name.startsWith(WEB_PREFIX)) return null;
  return name;
}

/** The body for a push, or null when there is nothing worth sending. */
export function buildNotifyBody(
  event: string,
  session: string,
  message: string | undefined,
): { event: string; session: string; message?: string } | null {
  if (!EVENTS.has(event)) return null;
  const name = usableSession(session);
  if (!name) return null;

  const text = typeof message === "string" ? message.trim() : "";
  return text ? { event, session: name, message: text } : { event, session: name };
}

/** The body for a binding record, or null if it could not be resumed anyway. */
export function buildRecordBody(
  agent: string,
  id: string,
  session: string,
  cwd: string | undefined,
): { agent: string; id: string; session: string; cwd?: string } | null {
  const name = usableSession(session);
  if (!name || !id) return null;
  return cwd ? { agent, id, session: name, cwd } : { agent, id, session: name };
}
