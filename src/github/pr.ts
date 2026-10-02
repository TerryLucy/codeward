import { gzipSync } from "node:zlib";
import { CONFIG_PATHS } from "../config.ts";
import { inlineCommentBody, parseFingerprint, SUMMARY_MARKER } from "../core/report.ts";
import type { Finding, ReviewResult } from "../types.ts";
import type { GitHub, PullRef } from "./client.ts";
import { httpStatus } from "./client.ts";

export async function loadRepoConfigText(gh: GitHub, owner: string, repo: string, ref: string): Promise<string | undefined> {
  for (const path of CONFIG_PATHS) {
    try {
      const res = await gh.repos.getContent({ owner, repo, path, ref });
      const data = res.data;
      if (!Array.isArray(data) && data.type === "file" && "content" in data) {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
    }
  }
  return undefined;
}

export async function fetchPullDiff(gh: GitHub, pr: PullRef): Promise<string> {
  const res = await gh.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    mediaType: { format: "diff" },
  });
  return res.data as unknown as string;
}

/** Diff between two commits, or undefined if history was rewritten (force-push) or the compare fails. */
export async function fetchCompareDiff(
  gh: GitHub,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string | undefined> {
  try {
    const meta = await gh.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 1 });
    if (meta.data.status !== "ahead") return undefined;
    const res = await gh.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      mediaType: { format: "diff" },
    });
    return res.data as unknown as string;
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404 || status === 422) return undefined;
    throw err;
  }
}

export async function findSummaryComment(gh: GitHub, pr: PullRef): Promise<{ id: number; body: string } | undefined> {
  const comments = await gh.paginate(gh.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pullNumber,
    per_page: 100,
  });
  const found = comments.find((c) => c.body?.includes(SUMMARY_MARKER));
  return found ? { id: found.id, body: found.body ?? "" } : undefined;
}

export async function upsertSummaryComment(gh: GitHub, pr: PullRef, body: string, existingId?: number): Promise<string> {
  if (existingId !== undefined) {
    const res = await gh.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: existingId, body });
    return res.data.html_url;
  }
  const res = await gh.issues.createComment({ owner: pr.owner, repo: pr.repo, issue_number: pr.pullNumber, body });
  return res.data.html_url;
}

export async function existingFingerprints(gh: GitHub, pr: PullRef): Promise<Set<string>> {
  const comments = await gh.paginate(gh.pulls.listReviewComments, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });
  const set = new Set<string>();
  for (const c of comments) {
    const fp = parseFingerprint(c.body);
    if (fp) set.add(fp);
  }
  return set;
}

function toReviewComment(f: Finding) {
  const base = { path: f.path, line: f.endLine ?? f.line, side: "RIGHT" as const, body: inlineCommentBody(f) };
  return f.endLine && f.endLine > f.line ? { ...base, start_line: f.line, start_side: "RIGHT" as const } : base;
}

/**
 * Posts findings as a single PR review (one notification). If GitHub rejects the batch
 * (e.g. a line moved since the diff was fetched), falls back to posting comments one by one.
 */
export async function postInlineReview(
  gh: GitHub,
  pr: PullRef,
  headSha: string,
  findings: Finding[],
  log: (msg: string) => void,
): Promise<{ posted: number; failed: number }> {
  if (findings.length === 0) return { posted: 0, failed: 0 };
  const comments = findings.map(toReviewComment);
  try {
    await gh.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: `Codeward found ${findings.length} issue(s) in this change. See the summary comment for details.`,
      comments,
    });
    return { posted: comments.length, failed: 0 };
  } catch (err) {
    if (httpStatus(err) !== 422) throw err;
    log(`batched review rejected (422); retrying comments individually`);
  }
  let posted = 0;
  let failed = 0;
  for (const c of comments) {
    try {
      await gh.pulls.createReviewComment({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pullNumber,
        commit_id: headSha,
        ...c,
      });
      posted++;
    } catch (err) {
      failed++;
      log(`could not comment on ${c.path}:${c.line}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { posted, failed };
}

const ANNOTATION_LEVEL = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
  info: "notice",
} as const;

export async function startCheckRun(gh: GitHub, owner: string, repo: string, headSha: string): Promise<number> {
  const res = await gh.checks.create({
    owner,
    repo,
    name: "Codeward",
    head_sha: headSha,
    status: "in_progress",
    output: { title: "Reviewing…", summary: "Codeward is reviewing this pull request." },
  });
  return res.data.id;
}

export async function completeCheckRun(
  gh: GitHub,
  owner: string,
  repo: string,
  checkRunId: number,
  result: ReviewResult,
  summaryMarkdown: string,
  failed: boolean,
): Promise<void> {
  const annotations = result.findings.map((f) => ({
    path: f.path,
    start_line: f.line,
    end_line: f.endLine ?? f.line,
    annotation_level: ANNOTATION_LEVEL[f.severity],
    title: `[${f.severity}] ${f.title}`.slice(0, 255),
    message: f.body.slice(0, 64_000) || f.title,
  }));
  const title = failed
    ? "Blocking issues found"
    : result.findings.length
      ? `${result.findings.length} suggestion(s)`
      : "No issues found";
  const conclusion = failed ? "failure" : result.findings.length ? "neutral" : "success";
  const summary = summaryMarkdown.slice(0, 65_000);
  for (let i = 0; i === 0 || i < annotations.length; i += 50) {
    const last = i + 50 >= annotations.length;
    await gh.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      ...(last ? { status: "completed" as const, conclusion } : {}),
      output: { title, summary, annotations: annotations.slice(i, i + 50) },
    });
  }
}

export async function failCheckRun(gh: GitHub, owner: string, repo: string, checkRunId: number, message: string): Promise<void> {
  await gh.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: "neutral",
    output: { title: "Review could not complete", summary: message.slice(0, 65_000) },
  });
}

export async function uploadSarif(
  gh: GitHub,
  owner: string,
  repo: string,
  commitSha: string,
  ref: string,
  sarif: object,
): Promise<void> {
  await gh.codeScanning.uploadSarif({
    owner,
    repo,
    commit_sha: commitSha,
    ref,
    sarif: gzipSync(Buffer.from(JSON.stringify(sarif))).toString("base64"),
    tool_name: "Codeward",
  });
}
