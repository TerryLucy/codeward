import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { Octokit } from "@octokit/rest";
import type { GitHub, PullRef } from "../github/client.ts";
import { reviewPullRequest } from "../github/run.ts";
import { VERSION } from "../version.ts";
import { KeyedQueue } from "./queue.ts";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function privateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY) return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  return readFileSync(required("GITHUB_APP_PRIVATE_KEY_PATH"), "utf8");
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));
}

const app = new App({
  appId: required("GITHUB_APP_ID"),
  privateKey: privateKey(),
  webhooks: { secret: required("GITHUB_WEBHOOK_SECRET") },
  Octokit,
});

const queue = new KeyedQueue((key, err) => log("review failed", { key, error: err instanceof Error ? err.message : String(err) }));

function enqueue(octokit: GitHub, pr: PullRef, force: boolean): void {
  const key = `${pr.owner}/${pr.repo}#${pr.pullNumber}`;
  queue.submit(key, async () => {
    const outcome = await reviewPullRequest({
      gh: octokit,
      pr,
      env: process.env,
      force,
      checkRun: true,
      log: (m) => log(m, { pr: key }),
    });
    log(outcome.status === "skipped" ? `skipped: ${outcome.reason}` : `reviewed: ${outcome.result.verdict}`, { pr: key });
  });
}

app.webhooks.on(
  ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize", "pull_request.ready_for_review"],
  ({ octokit, payload }) => {
    enqueue(octokit, { owner: payload.repository.owner.login, repo: payload.repository.name, pullNumber: payload.pull_request.number }, false);
  },
);

app.webhooks.on("issue_comment.created", async ({ octokit, payload }) => {
  if (!payload.issue.pull_request) return;
  if (!/^\/codeward\s+review\b/i.test(payload.comment.body.trim())) return;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  if (!TRUSTED_ASSOCIATIONS.has(payload.comment.author_association)) {
    log("ignored /codeward command from untrusted commenter", { user: payload.comment.user?.login });
    return;
  }
  await octokit.reactions.createForIssueComment({ owner, repo, comment_id: payload.comment.id, content: "eyes" });
  enqueue(octokit, { owner, repo, pullNumber: payload.issue.number }, true);
});

app.webhooks.onError((err) => log("webhook error", { error: err.message }));

const middleware = createNodeMiddleware(app.webhooks, { path: "/api/github/webhooks" });
const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION, queued: queue.size }));
    return;
  }
  middleware(req, res, () => {
    res.writeHead(404);
    res.end("not found");
  });
}).listen(port, () => log(`codeward app listening on :${port} (webhooks at /api/github/webhooks)`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal} received; draining ${queue.size} job(s)`);
    void queue.idle().then(() => process.exit(0));
  });
}
