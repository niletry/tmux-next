import { test, expect } from "bun:test";
import { imageExtension, uploadName, UPLOAD_DIR, MAX_UPLOAD_BYTES } from "./upload";

test("maps the accepted image types to an extension", () => {
  expect(imageExtension("image/png")).toBe("png");
  expect(imageExtension("image/jpeg")).toBe("jpg");
  expect(imageExtension("image/gif")).toBe("gif");
  expect(imageExtension("image/webp")).toBe("webp");
});

test("a content type with a charset parameter still maps", () => {
  expect(imageExtension("image/png; charset=binary")).toBe("png");
  expect(imageExtension("IMAGE/PNG")).toBe("png");
});

test("anything that is not an allow-listed image is refused", () => {
  // The security point: only known image types get written to disk.
  for (const type of [
    "text/html",
    "image/svg+xml", // scriptable, deliberately excluded
    "application/octet-stream",
    "application/x-sh",
    "text/plain",
    "",
    "image/../etc",
  ]) {
    expect(imageExtension(type)).toBe(null);
  }
});

test("the generated name is ours, with the right extension", () => {
  const name = uploadName("png");
  expect(name).toMatch(/^img-[0-9a-f-]+\.png$/);
});

test("two names never collide", () => {
  const names = new Set(Array.from({ length: 100 }, () => uploadName("jpg")));
  expect(names.size).toBe(100);
});

test("no generated name can escape the upload directory", () => {
  // Even though the extension is controlled, prove the name has no separators
  // a path join could walk out on.
  const name = uploadName("png");
  expect(name).not.toContain("/");
  expect(name).not.toContain("..");
});

test("the destination is a fixed directory under home, not client-driven", () => {
  expect(UPLOAD_DIR).toContain(".tmux-next");
  expect(UPLOAD_DIR.endsWith("uploads")).toBe(true);
});

test("the size cap is a sane, finite limit", () => {
  expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
});
