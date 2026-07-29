import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which sessions the user has pinned to the top of the list.
 *
 * Kept on the machine, not in a browser: the list reflects this machine's tmux
 * sessions, so a pin is a property of the machine too — pin on your phone and
 * the desktop shows it pinned as well. One JSON array of names, next to the
 * uploads and the gallery.
 */
export function pinsPath(): string {
  return process.env.TMUX_NEXT_PINS_PATH || join(homedir(), ".tmux-next", "pins.json");
}

/** Adds or removes a name, returning the new set (order preserved, no dupes). */
export function applyPin(pins: string[], name: string, pinned: boolean): string[] {
  const has = pins.includes(name);
  if (pinned && !has) return [...pins, name];
  if (!pinned && has) return pins.filter((n) => n !== name);
  return pins;
}

/** Follows a rename so a pinned session stays pinned under its new name. */
export function applyRename(pins: string[], from: string, to: string): string[] {
  return pins.map((n) => (n === from ? to : n));
}

export async function readPins(): Promise<string[]> {
  try {
    const data = await Bun.file(pinsPath()).json();
    return Array.isArray(data) ? data.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writePins(pins: string[]): Promise<void> {
  await Bun.write(pinsPath(), JSON.stringify(pins));
}

/** Pins or unpins one session, persisting the change. */
export async function setPin(name: string, pinned: boolean): Promise<void> {
  const next = applyPin(await readPins(), name, pinned);
  await writePins(next);
}

/** Rewrites a pin from one name to another; a no-op if it was not pinned. */
export async function renamePin(from: string, to: string): Promise<void> {
  const pins = await readPins();
  if (pins.includes(from)) await writePins(applyRename(pins, from, to));
}
