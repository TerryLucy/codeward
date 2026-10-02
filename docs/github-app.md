# Running Codeward as a GitHub App

## 1. Register the app

Use the manifest in `app.yml` (replace `YOUR-HOST`), or create it manually under
**Settings → Developer settings → GitHub Apps → New GitHub App** with:

| Permission | Access |
| --- | --- |
| Contents | Read |
| Metadata | Read |
| Pull requests | Read & write |
| Issues | Read & write (summary comments, reactions) |
| Checks | Read & write |
| Code scanning alerts (security events) | Read & write (only for `output.sarif`) |

Events: **Pull request**, **Issue comment**.
Webhook URL: `https://<host>/api/github/webhooks`. Set a webhook secret and download a private key.

## 2. Configure and run

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | App ID |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | PEM contents (`\n` escapes allowed) or file path |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret |
| `PORT` | Default `3000` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_API_KEY` | Model providers (at least one) |

```bash
npm ci && npm run build
node dist/app/index.js
# or: docker build -t codeward . && docker run -p 3000:3000 --env-file .env codeward
```

Health check: `GET /healthz`. For local development, forward webhooks with `npx smee-client` or `gh webhook forward`.

## 3. Behavior

- `opened`, `reopened`, `synchronize`, `ready_for_review` → review (incremental on new pushes).
- `/codeward review` comment from a trusted user → full re-review (👀 reaction acknowledges).
- Webhooks are acknowledged immediately; reviews run on an in-process per-PR queue where the latest push wins.
- A `Codeward` check run is created per head SHA: `failure` when findings reach `failOn`, `neutral` with suggestions, `success` when clean.

The queue is in-memory: run a single replica, or put a durable queue in front if you need horizontal scaling.
