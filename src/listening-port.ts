import { DEFAULT_PORT } from "./cli";

/**
 * The port the server actually bound, not the port a request claims to have
 * arrived on. A plugin route that needs to tell an agent where to `curl`
 * this process back (e.g. the supervisor plugin's `/api/notify` report) must
 * use this, never `url.port` from the request: behind the reverse proxy this
 * repo documents, the request's Host header carries the *proxy's* port (or
 * none at all over the default 80/443), which is not where anything is
 * actually listening. This module is deliberately generic — it knows nothing
 * about which plugin reads it — so a kernel-side "port I bound" fact stays a
 * kernel concept rather than something invented inside one plugin.
 */

let boundPort: number | null = null;

export function setListeningPort(port: number): void {
  boundPort = port;
}

/** Falls back to the documented default rather than to anything request-derived. */
export function getListeningPort(): number {
  return boundPort ?? DEFAULT_PORT;
}
