import type { Octokit } from "@octokit/rest";

export type GitHub = Octokit;

export interface PullRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

export function parsePullRef(ref: string): PullRef {
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(ref);
  const short = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
  const m = url ?? short;
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`Invalid PR reference "${ref}". Use owner/repo#123 or a PR URL.`);
  return { owner: m[1], repo: m[2], pullNumber: Number(m[3]) };
}

export function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}
