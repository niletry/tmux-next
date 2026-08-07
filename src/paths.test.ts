import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listDirectories, resolveDirectory } from "./paths";

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
}

test("a real directory resolves", async () => {
  const base = scratch();
  try {
    expect(await resolveDirectory(base)).toEqual({ ok: true, path: base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("`..` is collapsed rather than taken literally", async () => {
  const base = scratch();
  try {
    const inside = join(base, "inside");
    mkdirSync(inside);
    const climbed = await resolveDirectory(join(inside, "..", ".."));
    expect(climbed).toEqual({ ok: true, path: dirname(base) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlink resolves to where it lands, not where it sits", async () => {
  const base = scratch();
  const elsewhere = scratch();
  try {
    const link = join(base, "link");
    symlinkSync(elsewhere, link);
    expect(await resolveDirectory(link)).toEqual({ ok: true, path: elsewhere });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a path that does not exist is refused", async () => {
  const base = scratch();
  try {
    expect(await resolveDirectory(join(base, "nope"))).toEqual({ ok: false });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a file is refused — only directories can be browsed", async () => {
  const base = scratch();
  try {
    const file = join(base, "note.txt");
    await Bun.write(file, "hi");
    expect(await resolveDirectory(file)).toEqual({ ok: false });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("any directory on the machine can be listed", async () => {
  // The browse endpoint deliberately has no allow-list. Anyone who can reach
  // it can already attach to a session and run `ls`, so fencing the browser
  // while leaving a shell wide open only pretended to be a boundary.
  const listed = await listDirectories("/");
  expect(listed.ok).toBe(true);
  expect(listed.entries.length).toBeGreaterThan(0);
});

test("listing returns only directories, not files", async () => {
  const base = scratch();
  try {
    mkdirSync(join(base, "alpha"));
    await Bun.write(join(base, "readme.md"), "hi");
    const listed = await listDirectories(base);
    expect(listed.ok).toBe(true);
    expect(listed.entries.map((e) => e.name)).toEqual(["alpha"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing hides dot directories", async () => {
  const base = scratch();
  try {
    mkdirSync(join(base, "src"));
    mkdirSync(join(base, ".git"));
    const listed = await listDirectories(base);
    expect(listed.entries.map((e) => e.name)).toEqual(["src"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing sorts entries by name", async () => {
  const base = scratch();
  try {
    for (const n of ["zeta", "alpha", "mid"]) mkdirSync(join(base, n));
    const listed = await listDirectories(base);
    expect(listed.entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a directory reports its parent so browsing can climb", async () => {
  const base = scratch();
  try {
    const child = join(base, "child");
    mkdirSync(child);
    expect((await listDirectories(child)).parent).toBe(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the filesystem root reports no parent, so climbing stops there", async () => {
  // Nothing else bounds the climb now, so `/` has to bound it itself.
  expect((await listDirectories("/")).parent).toBe(null);
});

test("a listing that fails carries empty entries rather than throwing", async () => {
  const listed = await listDirectories("/definitely/not/a/path");
  expect(listed).toEqual({ ok: false, path: null, parent: null, entries: [] });
});

// --- creating a directory ---------------------------------------------------

import { validateDirName, createDirectory } from "./paths";
import { existsSync, readdirSync } from "node:fs";

/**
 * The name check is the first of three layers, and the only one that can be
 * exhausted by a table — so it is worth exhausting. The other two (resolving
 * the parent, and confirming the joined path still sits directly under it) are
 * exercised against a real filesystem below.
 */
// The reason is typed to the union rather than string so a renamed or removed
// reason breaks the table at compile time instead of at assertion time.
const REJECTED: [string, "empty" | "invalid" | "hidden" | "toolong"][] = [
  ["", "empty"],
  ["   ", "empty"],
  [".", "invalid"],
  ["..", "invalid"],
  ["../etc", "invalid"],
  ["a/b", "invalid"],
  ["/abs", "invalid"],
  ["a\\b", "invalid"],
  [".hidden", "hidden"],
  ["x".repeat(256), "toolong"],
];

test.each(REJECTED)("validateDirName rejects %p", (input, reason) => {
  const result = validateDirName(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
});

test.each([
  "project",
  "my project",
  "工单-1042",
  "a_b-c.d",
  "x".repeat(255),
])("validateDirName accepts %p", (input) => {
  expect(validateDirName(input).ok).toBe(true);
});

test("validateDirName trims before judging", () => {
  const result = validateDirName("  spaced  ");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.name).toBe("spaced");
});

test("createDirectory makes one level under the parent", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "mkdir-test-")));
  const result = await createDirectory(parent, "newproj");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.path).toBe(join(parent, "newproj"));
    expect(existsSync(result.path)).toBe(true);
  }
});

test("createDirectory refuses a name that would escape the parent", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "mkdir-test-")));
  const before = readdirSync(join(parent, ".."));

  for (const escape of ["..", "../escaped", "sub/deep"]) {
    const result = await createDirectory(parent, escape);
    expect(result.ok).toBe(false);
  }

  // Nothing appeared outside the parent, and nothing inside it either.
  expect(readdirSync(join(parent, ".."))).toEqual(before);
  expect(readdirSync(parent)).toEqual([]);
});

test("createDirectory reports an existing directory rather than reusing it", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "mkdir-test-")));
  expect((await createDirectory(parent, "dup")).ok).toBe(true);
  const second = await createDirectory(parent, "dup");
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("exists");
});

test("createDirectory refuses a parent that does not exist", async () => {
  const result = await createDirectory(join(tmpdir(), "no-such-parent-" + Math.random()), "x");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("badparent");
});
