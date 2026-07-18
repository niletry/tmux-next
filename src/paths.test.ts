import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinRoots, listDirectories, resolveWithinRoots } from "./paths";

const ROOTS = ["/home/sam", "/mnt/data"];

test("a path inside a root is allowed", () => {
  expect(isWithinRoots("/home/sam/projects/tmux-next", ROOTS)).toBe(true);
});

test("a root itself is allowed", () => {
  expect(isWithinRoots("/home/sam", ROOTS)).toBe(true);
});

test("a path outside every root is refused", () => {
  expect(isWithinRoots("/etc", ROOTS)).toBe(false);
});

test("a parent of a root is refused", () => {
  expect(isWithinRoots("/Users", ROOTS)).toBe(false);
});

test("a sibling sharing the root's prefix is refused", () => {
  // /home/samuel must not pass just because it starts with /home/sam.
  expect(isWithinRoots("/home/samuel/secrets", ROOTS)).toBe(false);
});

test("the second root is honoured too", () => {
  expect(isWithinRoots("/mnt/data/orbit", ROOTS)).toBe(true);
});

test("resolving climbs out of a root with .. and is refused", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const inside = join(base, "inside");
    mkdirSync(inside);
    const escaped = await resolveWithinRoots(join(inside, "..", ".."), [base]);
    expect(escaped.ok).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlink pointing outside a root is refused", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  try {
    const link = join(base, "escape");
    symlinkSync(outside, link);
    const followed = await resolveWithinRoots(link, [base]);
    expect(followed.ok).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a real directory inside a root resolves to its canonical path", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const inside = join(base, "project");
    mkdirSync(inside);
    const result = await resolveWithinRoots(inside, [base]);
    expect(result).toEqual({ ok: true, path: inside });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a path that does not exist is refused", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const result = await resolveWithinRoots(join(base, "nope"), [base]);
    expect(result.ok).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a file is refused because only directories can host a session", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const file = join(base, "notes.txt");
    await Bun.write(file, "hi");
    const result = await resolveWithinRoots(file, [base]);
    expect(result.ok).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing returns only directories, not files", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    mkdirSync(join(base, "alpha"));
    await Bun.write(join(base, "readme.md"), "hi");
    const listed = await listDirectories(base, [base]);
    expect(listed.ok).toBe(true);
    expect(listed.entries.map((e) => e.name)).toEqual(["alpha"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing hides dot directories", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    mkdirSync(join(base, "src"));
    mkdirSync(join(base, ".git"));
    const listed = await listDirectories(base, [base]);
    expect(listed.entries.map((e) => e.name)).toEqual(["src"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing sorts entries by name", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    for (const n of ["zeta", "alpha", "mid"]) mkdirSync(join(base, n));
    const listed = await listDirectories(base, [base]);
    expect(listed.entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listing a path outside the roots is refused", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  try {
    expect((await listDirectories(outside, [base])).ok).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a root reports no parent so browsing cannot climb out", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const listed = await listDirectories(base, [base]);
    expect(listed.parent).toBe(null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a directory below a root reports its parent", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  try {
    const child = join(base, "child");
    mkdirSync(child);
    const listed = await listDirectories(child, [base]);
    expect(listed.parent).toBe(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
