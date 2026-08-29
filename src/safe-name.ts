/**
 * A caller-supplied name reduced to a plain basename, or null if it is not one.
 *
 * The name reaches a path join, so anything that could climb out of the target
 * directory — a separator, `..`, a null byte — is refused rather than sanitised,
 * and so are dotfiles. What survives can only ever name a file directly inside
 * whatever directory the caller joins it against.
 */
export function safeBasename(name: string): string | null {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith(".")) return null; // covers "." and ".." and hidden files
  return name;
}
