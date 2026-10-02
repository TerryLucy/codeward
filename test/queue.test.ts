import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedQueue } from "../src/app/queue.ts";
import { parsePullRef } from "../src/github/client.ts";
import { applyOverrides } from "../src/overrides.ts";
import { defaultConfig, parseConfig } from "../src/config.ts";

test("KeyedQueue serializes per key and coalesces pending jobs", async () => {
  const q = new KeyedQueue(() => {});
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.submit("a", async () => {
    await gate;
    ran.push("a1");
  });
  q.submit("a", async () => void ran.push("a2"));
  q.submit("a", async () => void ran.push("a3"));
  q.submit("b", async () => void ran.push("b1"));
  release();
  await q.idle();
  await q.idle();
  assert.deepEqual(ran.sort(), ["a1", "a3", "b1"]);
});

test("parsePullRef accepts short refs and URLs", () => {
  assert.deepEqual(parsePullRef("octo/repo#12"), { owner: "octo", repo: "repo", pullNumber: 12 });
  assert.deepEqual(parsePullRef("https://github.com/octo/repo/pull/7/files"), { owner: "octo", repo: "repo", pullNumber: 7 });
  assert.throws(() => parsePullRef("octo/repo"));
});

test("config parsing and overrides", () => {
  const cfg = parseConfig("models:\n  quality: max\nreview:\n  failOn: critical\n  instructions: Prefer early returns.\n");
  assert.equal(cfg.models.quality, "max");
  assert.equal(cfg.review.failOn, "critical");
  assert.equal(cfg.review.maxComments, 25);
  const o = applyOverrides(defaultConfig(), { model: "openai/gpt-5", failOn: "none", sarif: true });
  assert.equal(o.models.review, "openai/gpt-5");
  assert.equal(o.models.summary, "openai/gpt-5");
  assert.equal(o.review.failOn, "none");
  assert.equal(o.output.sarif, true);
  assert.throws(() => applyOverrides(defaultConfig(), { failOn: "bogus" }));
  assert.throws(() => parseConfig("review:\n  maxComments: -1\n"));
});
