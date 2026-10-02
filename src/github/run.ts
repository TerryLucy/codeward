import type { Config } from "../config.ts";
import { parseConfig } from "../config.ts";
import type { FileDiff } from "../core/diff.ts";
import { commentableLines, parseDiff } from "../core/diff.ts";
import { fingerprint } from "../core/findings.ts";
import { computeVerdict, runReview } from "../core/harness.ts";
import { parseReviewedSha, renderSummary, toSarif } from "../core/report.ts";
import { ModelClient, providersFromEnv } from "../models/client.ts";
import type { Finding, ReviewResult } from "../types.ts";
import { VERSION } from "../version.ts";
import type { GitHub, PullRef } from "./client.ts";
import {
  completeCheckRun,
  existingFingerprints,
  failCheckRun,
  fetchCompareDiff,
  fetchPullDiff,
  findSummaryComment,
  loadRepoConfigText,
  postInlineReview,
  startCheckRun,
  upsertSummaryComment,
  uploadSarif,
} from "./pr.ts";

export interface ReviewPullOptions {
  gh: GitHub;
  pr: PullRef;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  /** Applied on top of the repository config (e.g. Action inputs). */
  overrides?: (config: Config) => Config;
  /** Bypass skip rules and incremental mode (manual `/codeward review`). */
  force?: boolean;
  /** Create/complete a GitHub check run (GitHub App mode). */
  checkRun?: boolean;
  /** When false, compute the review without writing anything to GitHub. */
  post?: boolean;
}

export type ReviewPullOutcome =
  | { status: "skipped"; reason: string }
  | { status: "reviewed"; result: ReviewResult; failed: boolean; summaryUrl?: string; config: Config; headSha: string };

function shouldSkip(
  config: Config,
  pr: { draft?: boolean; labels: { name?: string }[]; user: { login: string } | null },
): string | undefined {
  if (config.review.skipDrafts && pr.draft) return "pull request is a draft";
  const label = pr.labels.find((l) => l.name && config.review.skipLabels.includes(l.name));
  if (label?.name) return `label "${label.name}" present`;
  if (pr.user && config.review.skipAuthors.includes(pr.user.login)) return `author ${pr.user.login} is skipped`;
  return undefined;
}

function restrictToPullDiff(result: ReviewResult, fullFiles: FileDiff[]): ReviewResult {
  const lines = new Map(fullFiles.map((f) => [f.path, commentableLines(f)]));
  const keep: Finding[] = [];
  const moved: Finding[] = [];
  for (const f of result.findings) (lines.get(f.path)?.has(f.line) ? keep : moved).push(f);
  return { ...result, findings: keep, droppedFindings: [...moved, ...result.droppedFindings] };
}

export async function reviewPullRequest(opts: ReviewPullOptions): Promise<ReviewPullOutcome> {
  const { gh, pr, log } = opts;
  const post = opts.post ?? true;
  const { data: pull } = await gh.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.pullNumber });
  const headSha = pull.head.sha;

  // Config comes from the base branch so a PR cannot weaken its own review.
  const configText = await loadRepoConfigText(gh, pr.owner, pr.repo, pull.base.ref);
  let config = parseConfig(configText);
  if (opts.overrides) config = opts.overrides(config);

  if (pull.state !== "open") return { status: "skipped", reason: "pull request is not open" };
  if (!opts.force) {
    const reason = shouldSkip(config, pull);
    if (reason) return { status: "skipped", reason };
  }

  const existingSummary = post ? await findSummaryComment(gh, pr) : undefined;
  const previousSha = existingSummary ? parseReviewedSha(existingSummary.body) : undefined;
  if (!opts.force && previousSha === headSha) return { status: "skipped", reason: `head ${headSha.slice(0, 7)} already reviewed` };

  const fullDiff = await fetchPullDiff(gh, pr);
  const fullFiles = parseDiff(fullDiff);
  let reviewFiles = fullFiles;
  let incrementalFrom: string | undefined;
  if (!opts.force && config.review.incremental && previousSha) {
    const inc = await fetchCompareDiff(gh, pr.owner, pr.repo, previousSha, headSha);
    if (inc !== undefined) {
      reviewFiles = parseDiff(inc);
      incrementalFrom = previousSha;
      log(`incremental review ${previousSha.slice(0, 7)}..${headSha.slice(0, 7)}`);
    }
  }

  const providers = providersFromEnv(config.models, opts.env);
  if (providers.has("mock") && providers.size === 1 && opts.env.CODEWARD_MOCK !== "1") {
    return { status: "skipped", reason: "no model API keys configured (e.g. fork PR without secrets); set CODEWARD_MOCK=1 to use the offline mock model" };
  }

  const checkRunId = post && opts.checkRun ? await startCheckRun(gh, pr.owner, pr.repo, headSha) : undefined;
  try {
    const client = new ModelClient({
      models: config.models,
      maxCostUsd: config.review.maxCostUsd,
      providers,
      logger: log,
    });

    let result = await runReview({
      diff: reviewFiles,
      config,
      client,
      pr: { repo: `${pr.owner}/${pr.repo}`, title: pull.title, body: pull.body ?? "" },
      log,
    });
    result = restrictToPullDiff(result, fullFiles);

    const failed = computeVerdict(result.findings, config.review.failOn) === "request_changes";
    const summary = renderSummary(result, {
      headSha,
      incrementalFrom,
      linkFor: (f) => `https://github.com/${pr.owner}/${pr.repo}/blob/${headSha}/${f.path}#L${f.line}`,
    });
    if (!post) return { status: "reviewed", result, failed, config, headSha };

    if (config.output.inlineComments) {
      const seen = await existingFingerprints(gh, pr);
      const fresh = result.findings.filter((f) => !seen.has(fingerprint(f)));
      const { posted, failed: failedComments } = await postInlineReview(gh, pr, headSha, fresh, log);
      log(`inline comments: ${posted} posted, ${result.findings.length - fresh.length} already present, ${failedComments} failed`);
    }

    let summaryUrl: string | undefined;
    if (config.output.summaryComment) summaryUrl = await upsertSummaryComment(gh, pr, summary, existingSummary?.id);
    if (checkRunId !== undefined) await completeCheckRun(gh, pr.owner, pr.repo, checkRunId, result, summary, failed);

    if (config.output.sarif) {
      try {
        await uploadSarif(gh, pr.owner, pr.repo, headSha, `refs/pull/${pr.pullNumber}/head`, toSarif(result.findings, VERSION));
      } catch (err) {
        log(`SARIF upload failed (requires code scanning + security_events: write): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: "reviewed", result, failed, summaryUrl, config, headSha };
  } catch (err) {
    if (checkRunId !== undefined) {
      await failCheckRun(gh, pr.owner, pr.repo, checkRunId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
