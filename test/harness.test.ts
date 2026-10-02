import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { anchorFindings, dedupeFindings, fingerprint } from "../src/core/findings.ts";
import { parseDiff } from "../src/core/diff.ts";
import { runReview } from "../src/core/harness.ts";
import { extractJson, parseFindings } from "../src/core/parse.ts";
import { inlineCommentBody, parseFingerprint, parseReviewedSha, renderSummary, toSarif } from "../src/core/report.ts";
import { scanSecrets } from "../src/core/secrets.ts";
import { ModelClient } from "../src/models/client.ts";
import { MockProvider } from "../src/models/providers/mock.ts";
import type { Finding } from "../src/types.ts";

const sample = readFileSync(new URL("./fixtures/sample.diff", import.meta.url), "utf8");

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: "src/db/users.ts",
    line: 5,
    severity: "high",
    category: "bug",
    title: "Something is wrong",
    body: "Because.",
    confidence: 0.8,
    source: "llm",
    ...overrides,
  };
}

test("extractJson tolerates code fences and prose", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"findings": []}\n```'), { findings: [] });
  assert.deepEqual(extractJson('noise {"a": 1} trailing'), { a: 1 });
  assert.throws(() => extractJson("no json"));
});

test("parseFindings normalizes severities/categories and drops malformed items", () => {
  const text = JSON.stringify({
    findings: [
      { path: "a/src/x.ts", line: "3", severity: "Major", category: "Security issue", title: "T", body: "B", cwe: "cwe 89" },
      { path: "src/y.ts", severity: "low", title: "missing line" },
    ],
  });
  const { findings, invalid } = parseFindings(text, "m");
  assert.equal(invalid, 1);
  assert.equal(findings[0]?.path, "src/x.ts");
  assert.equal(findings[0]?.line, 3);
  assert.equal(findings[0]?.severity, "high");
  assert.equal(findings[0]?.category, "security");
  assert.equal(findings[0]?.cwe, "CWE-89");
});

test("anchorFindings snaps near-misses and rejects out-of-diff lines", () => {
  const files = parseDiff(sample);
  const { anchored, unanchored } = anchorFindings(
    [finding({ line: 5 }), finding({ line: 12 }), finding({ line: 200 }), finding({ path: "nope.ts" })],
    files,
  );
  assert.deepEqual(anchored.map((f) => f.line), [5, 10]);
  assert.equal(unanchored.length, 2);
});

test("dedupeFindings keeps the strongest duplicate", () => {
  const out = dedupeFindings([
    finding({ severity: "medium", category: "security", title: "SQL injection in query" }),
    finding({ line: 6, severity: "critical", category: "security", title: "SQL injection risk" }),
    finding({ line: 30, title: "Other" }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.severity, "critical");
});

test("fingerprints are stable across line moves and round-trip through comment bodies", () => {
  const a = finding({ line: 5 });
  const b = finding({ line: 50 });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(parseFingerprint(inlineCommentBody(a)), fingerprint(a));
});

test("scanSecrets detects real-looking keys and ignores placeholders", () => {
  const key = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,4 @@",
    " const a = 1;",
    `+const token = "${key}";`,
    '+const password = "your_password_here";',
    '+const apiKey = process.env.API_KEY;',
  ].join("\n");
  const found = scanSecrets(parseDiff(diff));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 2);
  assert.ok(!found[0]?.body.includes(key), "secret must be redacted");
});

test("runReview end-to-end with the mock provider", async () => {
  const config = defaultConfig();
  const client = new ModelClient({ models: config.models, maxCostUsd: 1, providers: new Map([["mock", new MockProvider()]]) });
  const result = await runReview({ diff: sample, config, client });
  assert.equal(result.verdict, "request_changes");
  assert.deepEqual(
    result.findings.map((f) => `${f.path}:${f.line}:${f.severity}`),
    ["src/config/aws.ts:2:critical", "src/db/users.ts:5:high", "src/db/users.ts:9:high"],
  );
  assert.ok(result.droppedFindings.some((f) => f.title === "Unresolved TODO"), "info finding below minSeverity is dropped");
  assert.deepEqual(result.errors, []);

  const md = renderSummary(result, { headSha: "abcdef1234567" });
  assert.equal(parseReviewedSha(md), "abcdef1234567");
  assert.match(md, /Changes requested/);

  const sarif = toSarif(result.findings, "0.0.0") as { runs: { results: unknown[] }[] };
  assert.equal(sarif.runs[0]?.results.length, 3);
});

test("failOn none never requests changes", async () => {
  const config = defaultConfig();
  config.review.failOn = "none";
  const client = new ModelClient({ models: config.models, maxCostUsd: 1, providers: new Map([["mock", new MockProvider()]]) });
  const result = await runReview({ diff: sample, config, client });
  assert.equal(result.verdict, "comment");
});
