import { z } from "zod";
import type { Category, Finding, Severity, Verdict } from "../types.ts";
import { CATEGORIES, SEVERITIES } from "../types.ts";

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model response contained no JSON object");
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: "critical",
  major: "high",
  error: "high",
  moderate: "medium",
  warning: "medium",
  minor: "low",
  nit: "info",
  suggestion: "info",
  note: "info",
};

function normalizeSeverity(v: unknown): Severity {
  const s = String(v ?? "").toLowerCase().trim();
  return SEVERITIES.find((x) => x === s) ?? SEVERITY_ALIASES[s] ?? "medium";
}

function normalizeCategory(v: unknown): Category {
  const s = String(v ?? "").toLowerCase().trim();
  return CATEGORIES.find((x) => x === s) ?? (s.includes("secur") ? "security" : "bug");
}

const rawFinding = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  endLine: z.coerce.number().int().positive().optional().catch(undefined),
  severity: z.unknown(),
  category: z.unknown(),
  title: z.string().min(1).max(300),
  body: z.string().default(""),
  suggestion: z.string().optional().catch(undefined),
  cwe: z.string().optional().catch(undefined),
  confidence: z.coerce.number().min(0).max(1).catch(0.7).default(0.7),
});

export function parseFindings(text: string, model: string): { findings: Finding[]; invalid: number } {
  const json = extractJson(text);
  const list = z.object({ findings: z.array(z.unknown()) }).parse(json).findings;
  const findings: Finding[] = [];
  let invalid = 0;
  for (const item of list) {
    const r = rawFinding.safeParse(item);
    if (!r.success) {
      invalid++;
      continue;
    }
    const f = r.data;
    const endLine = f.endLine && f.endLine > f.line ? f.endLine : undefined;
    findings.push({
      path: f.path.replace(/^[ab]\//, ""),
      line: f.line,
      ...(endLine ? { endLine } : {}),
      severity: normalizeSeverity(f.severity),
      category: normalizeCategory(f.category),
      title: f.title.trim(),
      body: f.body.trim(),
      ...(f.suggestion !== undefined && f.suggestion.trim() !== "" ? { suggestion: f.suggestion.replace(/\n$/, "") } : {}),
      ...(f.cwe ? { cwe: f.cwe.toUpperCase().replace(/^CWE[-_ ]?/, "CWE-") } : {}),
      confidence: f.confidence,
      source: "llm",
      model,
    });
  }
  return { findings, invalid };
}

export function parseSummary(text: string): { summary: string; verdict?: Verdict } {
  try {
    const parsed = z
      .object({ summary: z.string(), verdict: z.enum(["approve", "comment", "request_changes"]).optional().catch(undefined) })
      .parse(extractJson(text));
    return parsed.verdict ? { summary: parsed.summary, verdict: parsed.verdict } : { summary: parsed.summary };
  } catch {
    return { summary: text.trim() };
  }
}
