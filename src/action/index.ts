import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import type { PullRef } from "../github/client.ts";
import { reviewPullRequest } from "../github/run.ts";
import { applyOverrides } from "../overrides.ts";
import { summarizeUsage } from "../core/report.ts";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface EventPayload {
  pull_request?: { number: number };
  issue?: { number: number; pull_request?: unknown };
  comment?: { body?: string; author_association?: string };
  repository?: { name: string; owner: { login: string } };
}

function input(name: string): string | undefined {
  const v = core.getInput(name).trim();
  return v === "" ? undefined : v;
}

function resolvePull(eventName: string, payload: EventPayload): { pr?: PullRef; force: boolean; reason?: string } {
  const repo = payload.repository;
  if (!repo) return { force: false, reason: "event payload has no repository" };
  const base = { owner: repo.owner.login, repo: repo.name };
  if ((eventName === "pull_request" || eventName === "pull_request_target") && payload.pull_request) {
    return { pr: { ...base, pullNumber: payload.pull_request.number }, force: false };
  }
  if (eventName === "issue_comment" && payload.issue?.pull_request && payload.comment) {
    if (!/^\/codeward\s+review\b/i.test(payload.comment.body?.trim() ?? "")) return { force: false, reason: "comment is not a /codeward command" };
    if (!TRUSTED_ASSOCIATIONS.has(payload.comment.author_association ?? "")) {
      return { force: false, reason: `commenter association ${payload.comment.author_association} is not allowed to trigger reviews` };
    }
    return { pr: { ...base, pullNumber: payload.issue.number }, force: true };
  }
  if (eventName === "workflow_dispatch" && input("pull-number")) {
    return { pr: { ...base, pullNumber: Number(input("pull-number")) }, force: true };
  }
  return { force: false, reason: `unsupported event "${eventName}"` };
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as EventPayload;
  const { pr, force, reason } = resolvePull(eventName, payload);
  if (!pr) {
    core.info(`Codeward: nothing to do (${reason}).`);
    return;
  }
  if (eventName === "pull_request_target") {
    core.warning("Running on pull_request_target: Codeward only reads the diff via the API and never checks out PR code. Keep it that way.");
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: input("anthropic-api-key") ?? process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: input("openai-api-key") ?? process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: input("google-api-key") ?? process.env.GOOGLE_API_KEY,
    OPENAI_COMPATIBLE_API_KEY: input("openai-compatible-api-key") ?? process.env.OPENAI_COMPATIBLE_API_KEY,
  };
  for (const key of ["anthropic-api-key", "openai-api-key", "google-api-key", "openai-compatible-api-key"]) {
    const v = input(key);
    if (v) core.setSecret(v);
  }

  const gh = new Octokit({ auth: input("github-token"), baseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com" });
  const outcome = await reviewPullRequest({
    gh,
    pr,
    env,
    force,
    log: (m) => core.info(m),
    overrides: (c) =>
      applyOverrides(c, {
        model: input("model"),
        reviewModel: input("review-model"),
        securityModel: input("security-model"),
        summaryModel: input("summary-model"),
        quality: input("quality"),
        failOn: input("fail-on"),
        minSeverity: input("min-severity"),
        sarif: input("sarif") === undefined ? undefined : core.getBooleanInput("sarif"),
        openaiCompatibleBaseUrl: input("openai-compatible-base-url"),
      }),
  });

  if (outcome.status === "skipped") {
    core.info(`Codeward: skipped (${outcome.reason}).`);
    core.setOutput("verdict", "skipped");
    return;
  }
  const { result, failed } = outcome;
  for (const f of result.findings) {
    const props = { file: f.path, startLine: f.line, endLine: f.endLine ?? f.line, title: `[${f.severity}] ${f.title}` };
    if (f.severity === "critical" || f.severity === "high") core.error(f.body || f.title, props);
    else if (f.severity === "medium") core.warning(f.body || f.title, props);
    else core.notice(f.body || f.title, props);
  }
  const usage = summarizeUsage(result.usage);
  core.setOutput("verdict", result.verdict);
  core.setOutput("findings", String(result.findings.length));
  core.setOutput("cost-usd", usage.costUsd.toFixed(4));
  if (outcome.summaryUrl) core.setOutput("summary-url", outcome.summaryUrl);

  await core.summary
    .addHeading("Codeward review", 2)
    .addRaw(`Verdict: **${result.verdict}** · findings: ${result.findings.length} · models: ${usage.models.join(", ")} · ~$${usage.costUsd.toFixed(4)}`, true)
    .addRaw(outcome.summaryUrl ? `\n[Open summary comment](${outcome.summaryUrl})\n` : "", true)
    .write();

  if (failed) core.setFailed(`Codeward found findings at or above "${outcome.config.review.failOn}" severity.`);
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
