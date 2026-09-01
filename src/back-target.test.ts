import { test, expect } from "bun:test";
import { backTarget } from "../public/back-target.js";

const PAGES = [
  { id: "sessions", path: "./", titleKey: "nav.backToSessions" },
  { id: "jira", path: "p/jira/", titleKey: "jira.title" },
  { id: "gallery", path: "p/gallery/", titleKey: "gallery.title" },
];

test("no marker means the session list, which is what the link always did", () => {
  expect(backTarget("?target=work", PAGES).path).toBe("./");
});

test("a known marker sends the arrow back where you came from", () => {
  const back = backTarget("?target=work&from=jira", PAGES);
  expect(back.path).toBe("p/jira/");
  expect(back.titleKey).toBe("jira.title");
});

test("the marker is matched, never used as an address", () => {
  // Anything not in the table — a disabled plugin, a stale bookmark, or an
  // address someone typed in hoping the arrow would follow it.
  for (const from of ["https://example.com/", "../../etc", "notes", ""]) {
    expect(backTarget(`?from=${encodeURIComponent(from)}`, PAGES).path).toBe("./");
  }
});

test("the source page comes back with the view you left it in", () => {
  const back = backTarget("?target=work&from=jira&fq=" + encodeURIComponent("epic=ABC-1&status=In Progress"), PAGES);
  expect(back.path).toBe("p/jira/?epic=ABC-1&status=In+Progress");
});

test("the carried view is rebuilt, so it can only ever be a query", () => {
  for (const fq of ["//example.com/", "https://example.com/?a=1", "#/x"]) {
    const back = backTarget(`?from=jira&fq=${encodeURIComponent(fq)}`, PAGES);
    expect(back.path.startsWith("p/jira/?")).toBe(true);
    expect(back.path).not.toContain("//");
    expect(back.path).not.toContain("#");
  }
});

test("a view state with no recognisable source is dropped with it", () => {
  expect(backTarget("?from=nope&fq=epic%3DABC-1", PAGES).path).toBe("./");
});

test("the first page is the fallback, not the id 'sessions'", () => {
  // The table is built by the caller from the plugin registry; this module does
  // not know that a page called "sessions" exists.
  const only = [{ id: "a", path: "a/", titleKey: "k" }];
  expect(backTarget("?from=b", only).path).toBe("a/");
});
