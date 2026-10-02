export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "style",
  "testing",
  "docs",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type ReviewTask = "review" | "security" | "summary";

export interface Finding {
  path: string;
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  suggestion?: string;
  cwe?: string;
  confidence: number;
  source: "llm" | "secret-scanner";
  model?: string;
}

export interface Usage {
  model: string;
  task: ReviewTask;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export type Verdict = "approve" | "comment" | "request_changes";

export interface ReviewResult {
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  droppedFindings: Finding[];
  usage: Usage[];
  filesReviewed: string[];
  filesSkipped: string[];
  errors: string[];
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function atLeast(s: Severity, threshold: Severity): boolean {
  return severityRank(s) >= severityRank(threshold);
}
