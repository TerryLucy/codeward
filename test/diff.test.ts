import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commentableLines, parseDiff } from "../src/core/diff.ts";
import { chunkFiles, filterFiles } from "../src/core/chunker.ts";
import { defaultConfig } from "../src/config.ts";

const sample = readFileSync(new URL("./fixtures/sample.diff", import.meta.url), "utf8");

test("parseDiff handles modified, added, binary, renamed and deleted files", () => {
  const files = parseDiff(sample);
  const byPath = new Map(files.map((f) => [f.path, f]));
  assert.equal(files.length, 6);
  assert.equal(byPath.get("src/db/users.ts")?.status, "modified");
  assert.equal(byPath.get("src/config/aws.ts")?.status, "added");
  assert.equal(byPath.get("logo.png")?.binary, true);
  assert.equal(byPath.get("new/name.ts")?.status, "renamed");
  assert.equal(byPath.get("new/name.ts")?.oldPath, "old/name.ts");
  assert.equal(byPath.get("gone.ts")?.status, "deleted");
});

test("commentableLines tracks new-file line numbers for added and context lines", () => {
  const users = parseDiff(sample).find((f) => f.path === "src/db/users.ts");
  assert.ok(users);
  assert.deepEqual([...commentableLines(users)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const renamed = parseDiff(sample).find((f) => f.path === "new/name.ts");
  assert.ok(renamed);
  assert.deepEqual([...commentableLines(renamed)], [10, 11, 12]);
});

test("filterFiles skips lockfiles, binaries and deletions", () => {
  const { reviewable, skipped } = filterFiles(parseDiff(sample), { ...defaultConfig().review });
  assert.deepEqual(reviewable.map((f) => f.path), ["src/db/users.ts", "src/config/aws.ts", "new/name.ts"]);
  assert.deepEqual(
    skipped.map((s) => s.reason).sort(),
    ["binary", "deleted", "excluded"],
  );
});

test("chunkFiles respects the token budget and flags sensitive paths", () => {
  const { reviewable } = filterFiles(parseDiff(sample), { ...defaultConfig().review });
  const one = chunkFiles(reviewable, 100_000, ["**/config/**"]);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.sensitive, true);
  const many = chunkFiles(reviewable, 40, []);
  assert.ok(many.length >= 3);
  for (const c of many) assert.match(c.text, /^### File: /);
});
