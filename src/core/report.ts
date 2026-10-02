import type { Finding, ReviewResult, Severity, Usage } from "../types.ts";
import { SEVERITIES } from "../types.ts";
import { fingerprint } from "./findings.ts";

export const SUMMARY_MARKER = "<!-- codeward:summary -->";
const SHA_MARKER_RE = /<!-- codeward:sha=([0-9a-f]{7,40}) -->/;
const FP_MARKER_RE = /<!-- codeward:fp=([0-9a-f]{16}) -->/;

const BADGE: Record<Severity, string> = {
  critical: "🟥 Critical",
  high: "🟧 High",
  medium: "🟨 Medium",
  low: "🟦 Low",
  info: "⬜ Info",
};

const VERDICT_LABEL = {
  approve: "✅ No blocking issues",
  comment: "💬 Suggestions",
  request_changes: "⛔ Changes requested",
} as const;

export function inlineCommentBody(f: Finding): string {
  const meta = [f.category, f.cwe, f.source === "secret-scanner" ? "secret scanner" : undefined]
    .filter(Boolean)
    .join(" · ");
  const parts = [`**${BADGE[f.severity]}** · ${meta}`, `**${f.title}**`, f.body];
  if (f.suggestion !== undefined) parts.push("```suggestion\n" + f.suggestion + "\n```");
  parts.push(`<!-- codeward:fp=${fingerprint(f)} -->`);
  return parts.filter((p) => p.trim() !== "").join("\n\n");
}

export function parseFingerprint(body: string): string | undefined {
  return FP_MARKER_RE.exec(body)?.[1];
}

export function parseReviewedSha(body: string): string | undefined {
  return SHA_MARKER_RE.exec(body)?.[1];
}

export function summarizeUsage(usage: Usage[]): { models: string[]; costUsd: number; tokens: number } {
  return {
    models: [...new Set(usage.map((u) => u.model))],
    costUsd: usage.reduce((s, u) => s + u.costUsd, 0),
    tokens: usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0),
  };
}

function countBySeverity(findings: Finding[]): string {
  return SEVERITIES.slice()
    .reverse()
    .map((s) => ({ s, n: findings.filter((f) => f.severity === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${BADGE[x.s]}: ${x.n}`)
    .join(" · ");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface SummaryOptions {
  headSha?: string;
  linkFor?: (f: Finding) => string | undefined;
  incrementalFrom?: string;
}

export function renderSummary(result: ReviewResult, opts: SummaryOptions = {}): string {
  const usage = summarizeUsage(result.usage);
  const all = [...result.findings];
  const lines: string[] = [SUMMARY_MARKER];
  if (opts.headSha) lines.push(`<!-- codeward:sha=${opts.headSha} -->`);
  lines.push(`## Codeward review — ${VERDICT_LABEL[result.verdict]}`, "", result.summary.trim(), "");

  if (all.length) {
    lines.push(`**Findings:** ${countBySeverity(all)}`, "", "| Severity | Location | Issue |", "| --- | --- | --- |");
    for (const f of all) {
      const loc = `\`${f.path}:${f.line}\``;
      const link = opts.linkFor?.(f);
      lines.push(`| ${BADGE[f.severity]} | ${link ? `[${loc}](${link})` : loc} | ${escapeCell(f.title)} |`);
    }
    lines.push("");
  } else {
    lines.push("No issues at or above the configured severity threshold.", "");
  }

  if (result.droppedFindings.length) {
    lines.push(
      `<details><summary>${result.droppedFindings.length} additional lower-priority or out-of-diff note(s)</summary>`,
      "",
    );
    for (const f of result.droppedFindings.slice(0, 50)) {
      lines.push(`- ${BADGE[f.severity]} \`${f.path}:${f.line}\` — ${escapeCell(f.title)}`);
    }
    lines.push("", "</details>", "");
  }

  if (result.errors.length) {
    lines.push("<details><summary>⚠️ Partial review</summary>", "");
    for (const e of result.errors) lines.push(`- ${escapeCell(e.slice(0, 300))}`);
    lines.push("", "</details>", "");
  }

  const scope = opts.incrementalFrom ? `incremental since \`${opts.incrementalFrom.slice(0, 7)}\` · ` : "";
  lines.push(
    `<sub>${scope}${result.filesReviewed.length} file(s) reviewed` +
      (result.filesSkipped.length ? `, ${result.filesSkipped.length} skipped` : "") +
      ` · models: ${usage.models.map((m) => `\`${m}\``).join(", ") || "none"}` +
      ` · ${usage.tokens.toLocaleString("en-US")} tokens · ~$${usage.costUsd.toFixed(4)}` +
      " · comment `/codeward review` to re-run</sub>",
  );
  return lines.join("\n");
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: "9.5",
  high: "8.0",
  medium: "5.5",
  low: "3.0",
  info: "1.0",
};

/** SARIF 2.1.0 for GitHub code scanning. Only security findings are included. */
export function toSarif(findings: Finding[], version: string): object {
  const security = findings.filter((f) => f.category === "security");
  const rules = new Map<string, object>();
  const results = security.map((f) => {
    const ruleId = f.cwe ?? `codeward/${f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: f.title.slice(0, 120),
        shortDescription: { text: f.title },
        properties: {
          "security-severity": SECURITY_SEVERITY[f.severity],
          tags: ["security", ...(f.cwe ? [`external/cwe/${f.cwe.toLowerCase()}`] : [])],
        },
      });
    }
    return {
      ruleId,
      level: SARIF_LEVEL[f.severity],
      message: { text: `${f.title}\n\n${f.body}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.path },
            region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) },
          },
        },
      ],
      partialFingerprints: { codewardFingerprint: fingerprint(f) },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Codeward", version, informationUri: "https://github.com/TerryLucy/codeward", rules: [...rules.values()] } },
        results,
      },
    ],
  };
}
