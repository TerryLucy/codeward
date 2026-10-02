import picomatch from "picomatch";
import { DEFAULT_EXCLUDES } from "../config.ts";
import type { FileDiff } from "./diff.ts";
import { renderFileHeader, renderHunk } from "./diff.ts";
import { estimateTokens } from "./tokens.ts";

export interface Chunk {
  files: string[];
  text: string;
  tokens: number;
  sensitive: boolean;
}

export interface FilterOptions {
  include: string[];
  exclude: string[];
  sensitivePaths: string[];
  maxFiles: number;
}

export interface FilterResult {
  reviewable: FileDiff[];
  skipped: { path: string; reason: string }[];
}

const GLOB_OPTS = { dot: true } as const;

export function filterFiles(files: FileDiff[], opts: FilterOptions): FilterResult {
  const include = picomatch(opts.include, GLOB_OPTS);
  const exclude = picomatch([...DEFAULT_EXCLUDES, ...opts.exclude], GLOB_OPTS);
  const reviewable: FileDiff[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const f of files) {
    if (f.status === "deleted") skipped.push({ path: f.path, reason: "deleted" });
    else if (f.binary) skipped.push({ path: f.path, reason: "binary" });
    else if (f.hunks.length === 0) skipped.push({ path: f.path, reason: "no content changes" });
    else if (!include(f.path)) skipped.push({ path: f.path, reason: "not included" });
    else if (exclude(f.path)) skipped.push({ path: f.path, reason: "excluded" });
    else if (reviewable.length >= opts.maxFiles) skipped.push({ path: f.path, reason: "maxFiles limit" });
    else reviewable.push(f);
  }
  return { reviewable, skipped };
}

export function isSensitive(path: string, patterns: string[]): boolean {
  return patterns.length > 0 && picomatch(patterns, { ...GLOB_OPTS, nocase: true })(path);
}

/**
 * Packs rendered file diffs into chunks under `maxTokens`. Files larger than the budget are
 * split at hunk boundaries; each piece repeats the file header so the model keeps context.
 */
export function chunkFiles(files: FileDiff[], maxTokens: number, sensitivePaths: string[]): Chunk[] {
  const pieces: { path: string; text: string; tokens: number }[] = [];
  for (const f of files) {
    const header = renderFileHeader(f);
    let current = header;
    for (const h of f.hunks) {
      const hunkText = renderHunk(h);
      if (current !== header && estimateTokens(current + "\n" + hunkText) > maxTokens) {
        pieces.push({ path: f.path, text: current, tokens: estimateTokens(current) });
        current = header;
      }
      current += "\n" + hunkText;
    }
    pieces.push({ path: f.path, text: current, tokens: estimateTokens(current) });
  }

  const chunks: Chunk[] = [];
  let acc: typeof pieces = [];
  let accTokens = 0;
  const flush = () => {
    if (acc.length === 0) return;
    const filesInChunk = [...new Set(acc.map((p) => p.path))];
    chunks.push({
      files: filesInChunk,
      text: acc.map((p) => p.text).join("\n\n"),
      tokens: accTokens,
      sensitive: filesInChunk.some((p) => isSensitive(p, sensitivePaths)),
    });
    acc = [];
    accTokens = 0;
  };
  for (const p of pieces) {
    if (accTokens + p.tokens > maxTokens) flush();
    acc.push(p);
    accTokens += p.tokens;
  }
  flush();
  return chunks;
}
