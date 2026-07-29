import { test, expect } from "bun:test";
import { galleryKind, safeGalleryName, galleryFilePath, galleryDir } from "./gallery";

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
