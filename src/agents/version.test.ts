import { expect, test } from "bun:test";
import { versionFromCommand } from "./version";

test("claude's versioned binary name reads as its version", () => {
  expect(versionFromCommand("2.1.223")).toBe("2.1.223");
  expect(versionFromCommand("2.1.232")).toBe("2.1.232");
});

test("non-version commands read as null", () => {
  for (const c of ["opencode", "node", "claude", "sleep", "", "bash", "1.2", "1.2.3.4", "v1.2.3"]) {
    expect(versionFromCommand(c)).toBe(null);
  }
});
