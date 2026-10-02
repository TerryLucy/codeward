import type { Config } from "../config.ts";
import type { ModelClient } from "../models/client.ts";
import { BudgetExceededError } from "../models/client.ts";
import type { Finding, ReviewResult, Verdict } from "../types.ts";
import { atLeast } from "../types.ts";
import { chunkFiles, filterFiles } from "./chunker.ts";
import type { FileDiff } from "./diff.ts";
import { parseDiff } from "./diff.ts";
import { anchorFindings, dedupeFindings, sortFindings } from "./findings.ts";
import { mapLimit } from "./limit.ts";
import { parseFindings, parseSummary } from "./parse.ts";
import type { PrContext } from "./prompts.ts";
import { buildPassMessages, buildSummaryMessages } from "./prompts.ts";
import { scanSecrets } from "./secrets.ts";

export interface ReviewInput {
  diff: string | FileDiff[];
  config: Config;
  client: ModelClient;
  pr?: PrContext;
  log?: (msg: string) => void;
}

type Pass = "review" | "security";

export function computeVerdict(findings: Finding[], failOn: Config["review"]["failOn"]): Verdict {
  if (failOn !== "none" && findings.some((f) => atLeast(f.severity, failOn))) return "request_changes";
  return findings.length > 0 ? "comment" : "approve";
}

function digest(findings: Finding[]): string {
  return findings
    .slice(0, 40)
    .map((f) => `- [${f.severity}/${f.category}] ${f.path}:${f.line} ${f.title}`)
    .join("\n");
}

/**
 * The review harness: parse -> filter -> chunk -> (review + security passes per chunk, in parallel)
 * -> secret scan -> anchor to diff lines -> dedupe -> threshold -> summarize.
 */
export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const { config, client } = input;
  const log = input.log ?? (() => {});
  const pr = input.pr ?? {};
  const files = typeof input.diff === "string" ? parseDiff(input.diff) : input.diff;
  const { reviewable, skipped } = filterFiles(files, config.review);
  const errors: string[] = [];

  const passes: Pass[] = [];
  if (config.review.enabled) passes.push("review");
  if (config.review.security) passes.push("security");

  const chunks = chunkFiles(reviewable, config.review.chunkTokens, config.review.sensitivePaths);
  log(`reviewing ${reviewable.length} file(s) in ${chunks.length} chunk(s); passes: ${passes.join(", ") || "none"}`);

  const jobs = chunks.flatMap((chunk) => passes.map((pass) => ({ chunk, pass })));
  const llmFindings = (
    await mapLimit(jobs, config.review.concurrency, async ({ chunk, pass }) => {
      try {
        const res = await client.complete(
          pass,
          {
            messages: buildPassMessages(pass, chunk.text, pr, config.review.instructions),
            json: true,
            maxOutputTokens: 8_000,
          },
          { sensitive: chunk.sensitive },
        );
        const { findings, invalid } = parseFindings(res.text, res.model.id);
        if (invalid > 0) log(`${pass}: dropped ${invalid} malformed finding(s) from ${res.model.id}`);
        const allowed = new Set(chunk.files);
        return findings.filter((f) => allowed.has(f.path));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!(err instanceof BudgetExceededError) || !errors.some((e) => e.startsWith("Review budget"))) {
          errors.push(err instanceof BudgetExceededError ? msg : `${pass} pass failed for ${chunk.files.join(", ")}: ${msg}`);
        }
        log(`${pass} pass error: ${msg}`);
        return [];
      }
    })
  ).flat();

  const secretFindings = config.review.secretScan ? scanSecrets(reviewable) : [];
  const { anchored, unanchored } = anchorFindings([...secretFindings, ...llmFindings], reviewable);
  const confident = anchored.filter((f) => f.source === "secret-scanner" || f.confidence >= config.review.minConfidence);
  const deduped = sortFindings(dedupeFindings(confident));

  const posted: Finding[] = [];
  const dropped: Finding[] = [...unanchored];
  for (const f of deduped) {
    if (atLeast(f.severity, config.review.minSeverity) && posted.length < config.review.maxComments) posted.push(f);
    else dropped.push(f);
  }

  const verdict = computeVerdict(deduped, config.review.failOn);
  let summary: string;
  try {
    const res = await client.complete("summary", {
      messages: buildSummaryMessages(pr, reviewable.map((f) => f.path), digest(deduped)),
      json: true,
      maxOutputTokens: 1_500,
    });
    summary = parseSummary(res.text).summary;
  } catch (err) {
    log(`summary error: ${err instanceof Error ? err.message : String(err)}`);
    summary = deduped.length
      ? `Found ${deduped.length} issue(s) across ${reviewable.length} file(s).`
      : `No issues found across ${reviewable.length} file(s).`;
  }

  return {
    summary,
    verdict,
    findings: posted,
    droppedFindings: dropped,
    usage: client.usage,
    filesReviewed: reviewable.map((f) => f.path),
    filesSkipped: skipped.map((s) => `${s.path} (${s.reason})`),
    errors,
  };
}
