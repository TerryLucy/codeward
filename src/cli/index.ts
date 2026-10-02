import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { parseConfig } from "../config.ts";
import { runReview } from "../core/harness.ts";
import { renderSummary, toSarif } from "../core/report.ts";
import { ModelClient, providersFromEnv } from "../models/client.ts";
import { buildCatalog } from "../models/registry.ts";
import { selectModels } from "../models/selector.ts";
import type { ReviewTask } from "../types.ts";
import { parsePullRef } from "../github/client.ts";
import { reviewPullRequest } from "../github/run.ts";
import { applyOverrides } from "../overrides.ts";
import { VERSION } from "../version.ts";

const HELP = `codeward ${VERSION} — AI code review & security

Usage:
  codeward review [--diff <file|->] [--base <ref>] [options]   Review a local diff (default: git diff <base>...HEAD)
  codeward pr <owner/repo#N | url> [--post] [options]          Review a GitHub pull request (needs GITHUB_TOKEN)
  codeward models [--tokens N] [--sensitive]                   Show the catalog and which models the selector picks

Options:
  --config <path>        Config file (default: .codeward.yml if present)
  --model <id>           Use one model for every task, e.g. anthropic/claude-sonnet-4-5
  --review-model <id>    Override review model      --security-model <id>   Override security model
  --quality <q>          economy | balanced | max
  --fail-on <sev>        Exit 1 if findings at/above: info|low|medium|high|critical|none
  --min-severity <sev>   Minimum severity to report
  --format <f>           markdown (default) | json | sarif
  --out <file>           Write output to a file instead of stdout
  --post                 (pr) Post comments to GitHub; otherwise dry-run
  --verbose              Log model selection and progress to stderr
`;

function readConfig(path: string | undefined): string | undefined {
  const candidates = path ? [path] : [".codeward.yml", ".codeward.yaml", ".github/codeward.yml"];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      if (path) throw new Error(`Cannot read config ${path}`);
    }
  }
  return undefined;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      diff: { type: "string" },
      base: { type: "string" },
      config: { type: "string" },
      model: { type: "string" },
      "review-model": { type: "string" },
      "security-model": { type: "string" },
      quality: { type: "string" },
      "fail-on": { type: "string" },
      "min-severity": { type: "string" },
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
      post: { type: "boolean", default: false },
      tokens: { type: "string" },
      sensitive: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const log = values.verbose ? (m: string) => console.error(`· ${m}`) : () => {};
  const overrides = {
    model: values.model,
    reviewModel: values["review-model"],
    securityModel: values["security-model"],
    quality: values.quality,
    failOn: values["fail-on"],
    minSeverity: values["min-severity"],
  };
  const config = applyOverrides(parseConfig(readConfig(values.config)), overrides);
  const emit = (text: string) => (values.out ? writeFileSync(values.out, text) : console.log(text));

  if (command === "models") {
    const providers = providersFromEnv(config.models);
    const catalog = buildCatalog(config.models.catalog);
    const available = new Set(providers.keys());
    console.log("Catalog:");
    for (const m of catalog) {
      const ok = available.has(m.provider) ? "available" : "no key";
      console.log(`  ${m.id.padEnd(32)} ${m.tier.padEnd(9)} ctx=${String(m.contextWindow).padEnd(8)} $${m.inputCostPerMTok}/$${m.outputCostPerMTok} per MTok  [${ok}]`);
    }
    console.log("\nSelection:");
    for (const task of ["review", "security", "summary"] as ReviewTask[]) {
      try {
        const sel = selectModels({
          task,
          estimatedInputTokens: Number(values.tokens ?? 20_000),
          sensitive: values.sensitive,
          availableProviders: available,
          catalog,
          models: config.models,
          remainingBudgetUsd: config.review.maxCostUsd,
        });
        console.log(`  ${task.padEnd(9)} ${sel.candidates.map((m) => m.id).join(" -> ")}   (${sel.reason})`);
      } catch (err) {
        console.log(`  ${task.padEnd(9)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return 0;
  }

  if (command === "review") {
    let diff: string;
    if (values.diff === "-") diff = readFileSync(0, "utf8");
    else if (values.diff) diff = readFileSync(values.diff, "utf8");
    else diff = execFileSync("git", ["diff", `${values.base ?? "origin/main"}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const client = new ModelClient({
      models: config.models,
      maxCostUsd: config.review.maxCostUsd,
      providers: providersFromEnv(config.models),
      logger: log,
    });
    const result = await runReview({ diff, config, client, log });
    if (values.format === "json") emit(JSON.stringify(result, null, 2));
    else if (values.format === "sarif") emit(JSON.stringify(toSarif(result.findings, VERSION), null, 2));
    else emit(renderSummary(result) + "\n\n" + result.findings.map((f) => `- [${f.severity}] ${f.path}:${f.line} ${f.title}\n  ${f.body.replace(/\n/g, "\n  ")}`).join("\n"));
    return result.verdict === "request_changes" ? 1 : 0;
  }

  if (command === "pr") {
    const ref = positionals[1];
    if (!ref) throw new Error("usage: codeward pr <owner/repo#N>");
    const gh = new Octokit({ auth: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN });
    const outcome = await reviewPullRequest({
      gh,
      pr: parsePullRef(ref),
      env: process.env,
      log,
      force: true,
      post: values.post,
      overrides: (c) => applyOverrides(c, overrides),
    });
    if (outcome.status === "skipped") {
      console.error(`skipped: ${outcome.reason}`);
      return 0;
    }
    if (values.format === "json") emit(JSON.stringify(outcome.result, null, 2));
    else emit(renderSummary(outcome.result, { headSha: outcome.headSha }));
    if (outcome.summaryUrl) console.error(`posted: ${outcome.summaryUrl}`);
    return outcome.failed ? 1 : 0;
  }

  console.error(`Unknown command "${command}".\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
