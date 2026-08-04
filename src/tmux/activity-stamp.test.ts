import { expect, test } from "bun:test";
import { nextStamp, type ActivityEntry } from "./activity-stamp";

test("first sight seeds from tmux window_activity, not the clock", () => {
  const entry = nextStamp(undefined, "hashA", 1000, 9999);
  expect(entry).toEqual({ hash: "hashA", epoch: 1000 });
});

test("a changed screen stamps the current time", () => {
  const prev: ActivityEntry = { hash: "hashA", epoch: 1000 };
  const entry = nextStamp(prev, "hashB", 1000, 9999);
  expect(entry).toEqual({ hash: "hashB", epoch: 9999 });
});

test("an unchanged screen keeps the prior stamp", () => {
  const prev: ActivityEntry = { hash: "hashA", epoch: 1000 };
  const entry = nextStamp(prev, "hashA", 5000, 9999);
  expect(entry).toBe(prev);
});

test("a session idle across many polls never advances", () => {
  let entry = nextStamp(undefined, "stable", 1000, 1000);
  for (const now of [2000, 3000, 4000]) entry = nextStamp(entry, "stable", 1234, now);
  expect(entry.epoch).toBe(1000);
});
