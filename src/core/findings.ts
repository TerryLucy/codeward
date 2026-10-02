import { createHash } from "node:crypto";
import type { Finding } from "../types.ts";
import { severityRank } from "../types.ts";
import type { FileDiff } from "./diff.ts";
import { commentableLines } from "./diff.ts";

const SNAP_DISTANCE = 3;

export interface AnchorResult {
  anchored: Finding[];
  unanchored: Finding[];
}

/**
 * Ensures each finding points at a line GitHub will accept a review comment on.
 * Findings slightly off (models miscount) are snapped to the nearest commentable line.
 */
export function anchorFindings(findings: Finding[], files: FileDiff[]): AnchorResult {
  const lines = new Map(files.map((f) => [f.path, commentableLines(f)]));
  const anchored: Finding[] = [];
  const unanchored: Finding[] = [];
  for (const f of findings) {
    const set = lines.get(f.path);
    if (!set) {
      unanchored.push(f);
      continue;
    }
    if (set.has(f.line)) {
      const endOk = f.endLine === undefined || rangeCommentable(set, f.line, f.endLine);
      if (endOk) anchored.push(f);
      else {
        const { endLine: _endLine, suggestion: _suggestion, ...rest } = f;
        anchored.push(rest);
      }
      continue;
    }
    let best: number | undefined;
    for (let d = 1; d <= SNAP_DISTANCE && best === undefined; d++) {
      if (set.has(f.line - d)) best = f.line - d;
      else if (set.has(f.line + d)) best = f.line + d;
    }
    if (best === undefined) unanchored.push(f);
    else {
      const { endLine: _endLine, suggestion: _suggestion, ...rest } = f;
      anchored.push({ ...rest, line: best });
    }
  }
  return { anchored, unanchored };
}

function rangeCommentable(set: Set<number>, start: number, end: number): boolean {
  for (let i = start; i <= end; i++) if (!set.has(i)) return false;
  return true;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Stable across pushes: does not include the line number. */
export function fingerprint(f: Finding): string {
  return createHash("sha256")
    .update(`${f.path}\u0000${f.category}\u0000${normalizeTitle(f.title)}`)
    .digest("hex")
    .slice(0, 16);
}

function better(a: Finding, b: Finding): Finding {
  const rank = severityRank(b.severity) - severityRank(a.severity);
  if (rank !== 0) return rank > 0 ? b : a;
  if (a.source !== b.source) return a.source === "secret-scanner" ? a : b;
  return b.confidence > a.confidence ? b : a;
}

function similar(a: Finding, b: Finding): boolean {
  if (a.path !== b.path || Math.abs(a.line - b.line) > 2) return false;
  if (a.category === b.category) return true;
  const ta = new Set(normalizeTitle(a.title).split(" "));
  const tb = normalizeTitle(b.title).split(" ");
  const overlap = tb.filter((w) => w.length > 3 && ta.has(w)).length;
  return overlap >= 2;
}

/** Merges duplicate findings from overlapping passes/models, keeping the strongest. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const idx = out.findIndex((o) => similar(o, f));
    if (idx === -1) out.push(f);
    else {
      const existing = out[idx];
      if (existing) out[idx] = better(existing, f);
    }
  }
  return out;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.confidence - a.confidence ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}
