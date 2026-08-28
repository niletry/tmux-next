import { join } from "node:path";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";

/**
 * A drop folder whose contents the web UI shows: images inline, HTML/SVG
 * rendered, everything else offered to download. A fixed directory rather than
 * anywhere on disk keeps this from becoming a file browser onto the whole
 * machine — the same stance the upload path takes.
 */
export function galleryDir(): string {
  return pluginStateDir("gallery");
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const HTML = /\.html?$/i;

export type GalleryKind = "image" | "html" | "other";

/** How the client should present a file, decided from its extension. */
export function galleryKind(name: string): GalleryKind {
  if (IMAGE.test(name)) return "image";
  if (HTML.test(name)) return "html";
  return "other";
}

/**
 * A caller-supplied name reduced to a plain basename, or null if it is not one.
 *
 * The name reaches a path join, so anything that could climb out of the gallery
 * — a separator, `..`, a null byte — is refused rather than sanitised, and so
 * are dotfiles. What survives can only ever name a file directly inside the
 * gallery directory.
 */
export function safeGalleryName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith(".")) return null; // covers "." and ".." and hidden files
  return name;
}

/** The on-disk path for a gallery file, or null if the name is not safe. */
export function galleryFilePath(name: string): string | null {
  const safe = safeGalleryName(name);
  return safe ? join(galleryDir(), safe) : null;
}

/**
 * Uploads into the gallery are capped so a broken client cannot balloon the
 * server's memory; the viewer renders HTML in a sandbox, so unlike the
 * terminal's image-only upload there is deliberately no type allow-list — the
 * gallery's job is to show whatever lands in the drop folder.
 */
export const MAX_GALLERY_UPLOAD_BYTES = 20 * 1024 * 1024;

/** name → { base, ext }, where ext keeps the dot and is "" when there is none. */
function splitExt(name: string): { base: string; ext: string } {
  const m = name.match(/^(.*?)(\.[^.]+)?$/);
  return { base: m?.[1] ?? name, ext: m?.[2] ?? "" };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes an uploaded file into the gallery, keeping the caller's basename.
 *
 * The name goes through `safeGalleryName` first, so it can never name anything
 * outside the gallery. A collision is given a numeric suffix (`x.png` →
 * `x-2.png`) rather than silently overwriting what is already there. Returns
 * the final name on disk, or null when the name is refused.
 */
export async function saveGalleryUpload(name: string, bytes: Uint8Array): Promise<string | null> {
  const safe = safeGalleryName(name);
  if (!safe) return null;
  await mkdir(galleryDir(), { recursive: true });
  const { base, ext } = splitExt(safe);
  let candidate = safe;
  for (let i = 2; ; i++) {
    if (!(await exists(join(galleryDir(), candidate)))) break;
    candidate = `${base}-${i}${ext}`;
  }
  await writeFile(join(galleryDir(), candidate), bytes);
  return candidate;
}

export type GalleryEntry = { name: string; kind: GalleryKind; size: number; mtime: number };

/** The gallery's files, newest first. A missing directory reads as empty. */
export async function listGallery(): Promise<GalleryEntry[]> {
  let names: string[];
  try {
    names = await readdir(galleryDir());
  } catch {
    return [];
  }

  const entries: GalleryEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const s = await stat(join(galleryDir(), name));
      if (s.isFile()) {
        entries.push({ name, kind: galleryKind(name), size: s.size, mtime: s.mtimeMs });
      }
    } catch {
      // A file that vanished between readdir and stat is simply skipped.
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}
