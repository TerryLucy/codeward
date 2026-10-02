# Codeward

AI code review and security scanning that runs natively in GitHub — as a **GitHub Action** (zero hosting) or a **GitHub App** (org-wide, with check runs) — on top of a provider-agnostic **model selector**.

```
PR opened / pushed / "/codeward review"
        │
        ▼
 ┌──────────────┐   diff via API (never checks out PR code)
 │ GitHub layer │── config from BASE branch (.codeward.yml)
 └──────┬───────┘
        ▼
 ┌──────────────────────────── harness ─────────────────────────────┐
 │ parse diff → filter (globs, lockfiles, binaries) → chunk by tokens │
 │      ├── review pass   ┐  per chunk, in parallel,                  │
 │      ├── security pass ┘  model chosen by the selector             │
 │      └── secret scanner (deterministic, redacted)                  │
 │ anchor to commentable lines → dedupe → confidence/severity gates   │
 │ → summary pass → verdict                                           │
 └──────┬─────────────────────────────────────────────────────────────┘
        ▼
 inline review comments (deduped across pushes) · summary comment
 check run / job status + annotations · optional SARIF → code scanning
```

## Model selector

Providers: **Anthropic**, **OpenAI**, **Google Gemini**, and any **OpenAI-compatible** endpoint (OpenRouter, Azure OpenAI v1, vLLM, Ollama, LiteLLM). A provider is available when its key is set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` + key).

For each task (`review`, `security`, `summary`) the selector returns an ordered candidate list:

1. **Pinned** — `models.<task>` set to an id or a fallback list → used as-is.
2. **Auto** — filter the catalog to models with credentials, in the provider allowlist, whose context window fits the chunk; score by
   - tier fit: summary → `fast`, review → `balanced`, security → `frontier`; `quality: economy|max` shifts one tier; chunks touching `sensitivePaths` bump review to `frontier`
   - task strength, provider preference order, relative cost, remaining budget
3. Fallbacks are **diversified across providers** (an Anthropic outage falls back to OpenAI, then Google).

The client retries 408/409/429/5xx with exponential backoff, then fails over to the next candidate, tracks tokens and cost per call, and stops at `review.maxCostUsd`.

```bash
codeward models --tokens 50000 --sensitive   # show catalog + what auto picks
```

The built-in catalog and prices live in `src/models/registry.ts`; extend or override them per repo with `models.catalog`.

## Use as a GitHub Action

```yaml
# .github/workflows/codeward.yml
name: Codeward
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
concurrency:
  group: codeward-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
jobs:
  review:
    if: github.event_name == 'pull_request' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/codeward'))
    runs-on: ubuntu-latest
    steps:
      - uses: TerryLucy/codeward@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          # model: anthropic/claude-sonnet-4-5   # optional pin
          # fail-on: high
          # sarif: true                          # also add `security-events: write`
```

Make the job a required status check to block merges on findings ≥ `failOn`. Codeward posts `COMMENT` reviews (never sticky `REQUEST_CHANGES`) so gating is done by the check, which clears itself on the next push. Fork PRs without secrets are skipped instead of reviewed with a fake model.

Inputs and outputs: see [`action.yml`](action.yml).

## Use as a GitHub App

See [docs/github-app.md](docs/github-app.md). In short: create the app from [`app.yml`](app.yml), then

```bash
docker build -t codeward .
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=... -e GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" -e GITHUB_WEBHOOK_SECRET=... \
  -e ANTHROPIC_API_KEY=... codeward
```

The app reviews every PR in installed repos, creates a `Codeward` check run with annotations, and responds to `/codeward review` from owners/members/collaborators.

## CLI

```bash
npm ci && npm run build
node dist/cli/index.js review --base origin/main -v          # review local branch
node dist/cli/index.js review --diff changes.patch --format json
node dist/cli/index.js pr TerryLucy/codeward#1              # dry-run against a PR (GITHUB_TOKEN)
node dist/cli/index.js pr TerryLucy/codeward#1 --post       # post results
CODEWARD_MOCK=1 node dist/cli/index.js review --diff test/fixtures/sample.diff   # offline
```

## Configuration

Optional `.codeward.yml` (or `.github/codeward.yml`) — loaded from the **base** branch. See [`.codeward.example.yml`](.codeward.example.yml) for every option: model pins, quality preset, severity/confidence gates, budget, include/exclude globs, sensitive paths, repo-specific instructions, incremental mode, outputs.

## Security posture

- Never checks out or executes PR code; reads diffs through the API.
- Config is read from the base branch, so a PR cannot disable its own review.
- The diff is wrapped as untrusted data and models are instructed to ignore embedded instructions (prompt-injection guard); output is schema-validated.
- `/codeward` commands are only honored from OWNER/MEMBER/COLLABORATOR.
- Detected secrets are redacted in comments.

## Development

```bash
npm ci
npm run check      # typecheck + lint + tests (node:test, native TS type stripping)
npm run build      # esbuild bundles → dist/{action,app,cli}; dist/action is committed
```

Layout: `src/models` (providers, registry, selector, client) · `src/core` (diff, chunker, prompts, parsing, secrets, findings, harness, report/SARIF) · `src/github` (API ops + PR orchestration) · `src/action` · `src/app` · `src/cli`.
