import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where uploaded images land, and how big they may be.
 *
 * A dedicated directory rather than the session's working tree: writing into a
 * user's project would be intrusive, and a fixed destination is what keeps the
 * client from steering the write anywhere via a crafted name.
 */
export const UPLOAD_DIR = join(homedir(), ".tmux-next", "uploads");
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The file extension for an accepted image content type, or null.
 *
 * An allow-list, not a guess: the type comes from the client, and the whole
 * point is to refuse anything that isn't a known image so the endpoint never
 * writes an executable or a `.html` someone could later be tricked into
 * opening. The extension is derived here, never taken from a client-supplied
 * filename, so there is nothing to traverse or spoof.
 */
export function imageExtension(contentType: string): string | null {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  switch (type) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/**
 * A generated, collision-free filename for an upload.
 *
 * The name is ours, not the client's: `img-<uuid>.<ext>` with a random id, so
 * two uploads never clash and no part of the path comes from user input.
 */
export function uploadName(ext: string): string {
  return `img-${crypto.randomUUID()}.${ext}`;
}
