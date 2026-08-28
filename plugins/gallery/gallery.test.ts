import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  galleryKind,
  safeGalleryName,
  galleryFilePath,
  galleryDir,
  saveGalleryUpload,
  MAX_GALLERY_UPLOAD_BYTES,
} from "./gallery";

test("classifies files by extension", () => {
  expect(galleryKind("chart.png")).toBe("image");
  expect(galleryKind("a.JPEG")).toBe("image");
  expect(galleryKind("logo.svg")).toBe("image");
  expect(galleryKind("report.html")).toBe("html");
  expect(galleryKind("page.HTM")).toBe("html");
  expect(galleryKind("notes.pdf")).toBe("other");
  expect(galleryKind("data.txt")).toBe("other");
});

test("accepts an ordinary basename", () => {
  expect(safeGalleryName("chart-2.png")).toBe("chart-2.png");
  expect(safeGalleryName("我的图.png")).toBe("我的图.png");
});

test("refuses anything that could climb out of the gallery", () => {
  for (const bad of [
    "../secret",
    "a/b.png",
    "a\\b.png",
    "..",
    ".",
    ".hidden",
    "with\0null.png",
    "",
  ]) {
    expect(safeGalleryName(bad)).toBe(null);
  }
});

test("a file path is always inside the gallery directory", () => {
  const p = galleryFilePath("x.png");
  expect(p).toBe(`${galleryDir()}/x.png`);
  expect(galleryFilePath("../x.png")).toBe(null);
  expect(galleryFilePath("sub/x.png")).toBe(null);
});

test("upload saves bytes under the caller's basename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-gallery-"));
  const old = process.env.TMUX_NEXT_GALLERY_DIR;
  process.env.TMUX_NEXT_GALLERY_DIR = dir;
  try {
    const name = await saveGalleryUpload("我的图.png", new TextEncoder().encode("PNGDATA"));
    expect(name).toBe("我的图.png");
    expect(await readFile(join(dir, "我的图.png"), "utf8")).toBe("PNGDATA");
  } finally {
    process.env.TMUX_NEXT_GALLERY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload dedupes a colliding name with a numeric suffix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-gallery-"));
  const old = process.env.TMUX_NEXT_GALLERY_DIR;
  process.env.TMUX_NEXT_GALLERY_DIR = dir;
  try {
    await writeFile(join(dir, "dup.png"), "first");
    expect(await saveGalleryUpload("dup.png", new TextEncoder().encode("second"))).toBe(
      "dup-2.png",
    );
    expect(await saveGalleryUpload("dup.png", new TextEncoder().encode("third"))).toBe(
      "dup-3.png",
    );
    // A name without an extension gets the suffix appended plainly.
    await writeFile(join(dir, "readme"), "x");
    expect(await saveGalleryUpload("readme", new TextEncoder().encode("y"))).toBe("readme-2");
  } finally {
    process.env.TMUX_NEXT_GALLERY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload refuses a name that could climb out, writing nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-gallery-"));
  const old = process.env.TMUX_NEXT_GALLERY_DIR;
  process.env.TMUX_NEXT_GALLERY_DIR = dir;
  try {
    for (const bad of ["../escape.png", "sub/x.png", ".hidden", ""]) {
      expect(await saveGalleryUpload(bad, new TextEncoder().encode("x"))).toBe(null);
    }
    expect((await readdir(dir)).length).toBe(0);
  } finally {
    process.env.TMUX_NEXT_GALLERY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload cap is a sane constant the endpoint enforces", () => {
  expect(MAX_GALLERY_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
});
