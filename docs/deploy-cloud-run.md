# Deploying NecroLegacy for free

| Part | Service | Free allowance used |
|---|---|---|
| Web app | Render static site (`render.yaml`) | Free static hosting on a CDN |
| API | Google Cloud Run, request-based billing | 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests a month |
| Postgres + pgvector | Neon Free | 1 GB storage, 100 compute-hours a month, wakes on its own after idling |
| Redis cache | Upstash Free | 256 MB, 500,000 commands a month |
| LLM | AxForge Free, through `LLM_PROVIDER=openai_compatible` | 3 million tokens every 30 days, shared across models; up to 8 calls at once |
| Embeddings | Built-in local `hash` provider | No external service |

Free-tier figures change; check each provider's pricing page before relying on them. Google Cloud needs a billing
account (a card) even when usage stays inside the free tier. The other services need no card.

## Why these settings

- **One API instance** (`--max-instances 1`). Live sessions are held in memory, so a second instance would not
  see them. Finished results are cached in Redis, so a repeated upload or preset replays instantly even after the
  instance restarts.
- **Request-based billing** (`--cpu-throttling`). Cloud Run gives the instance CPU only while a request is open and
  charges nothing while idle. The browser and the Kiro MCP server both keep the session's event stream open while
  a pipeline runs, so the pipeline always has CPU. Instance-based billing would charge every idle minute: an uptime
  pinger or crawler keeping the instance awake would cost about $50 a month.
- **Scale to zero** (`--min-instances 0`). The first request after a quiet period waits for a cold start of
  several seconds. Do not point an uptime monitor at the API; it buys nothing here and keeps the instance awake.
- **2 GiB memory**. One process peaks at about 1.1 GB running all three presets, and the worker pool adds two
  processes.
- **Client IP** (`CLIENT_IP_HEADER=x-forwarded-for`). The rate limiter uses the last entry, which Cloud Run appends
  after anything a caller sends. This behaviour is observed, not formally documented by Google.

## 1. Data services and the LLM key

1. **Neon**: the repo is linked to project `necrolegacy` (`crimson-band-09568351`, AWS US East 2) through `neon.ts`
   and the git-ignored `.neon` file. `neon login` then `neon deploy` writes `.env.local` with `DATABASE_URL` (pooled)
   and `DATABASE_URL_UNPOOLED` (direct). The API needs the **direct** one: its startup runs `CREATE EXTENSION`, a
   session-level statement, and it keeps its own small connection pool. The API enables `vector` on first start.
2. **Upstash**: create a Redis database in a region near `us-central1` and copy its `rediss://` URL.
3. **AxForge**: create an API key at <https://axforge.ai> (no card). `deploy-api` uses `qwen3.8-flash-next` as the
   primary and `qwen3.8-27b` as the fallback. Both read images, so a scan OCR is unsure about gets two attempts on
   two different models. Both answer without thinking by default, which keeps replies inside the 30-second provider
   timeout. AxForge rejects unknown request fields with a 400, so leave `LLM_*_REASONING_EFFORT` unset. Do not pick
   `glm-5.3-flash`: it always thinks, sometimes for minutes. Prompts and replies are not stored, logged or used for
   training (hosted in Stockholm). The model list is public at `https://api.axforge.ai/v1/public/models`.
   Image calls cap replies at 2,560 tokens and ask for minified JSON. A 429 or 503 with a `retry-after` of 10 s or
   less is retried once on the same model, and every 429 or 413 is logged as `llm rate limited: host=… status=…`
   with whatever limit details the provider returns. We moved off Groq in November 2026 because its free tier
   (8,000 tokens a minute, 200,000 a day) refused image calls for most of a day of testing.

## 2. Google Cloud (one time)

```sh
PROJECT_ID=your-project-id
REGION=us-central1            # a Tier 1 region, where the free tier and lowest prices apply
REPO=timothylee58/NecroLegacy
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com

# Image registry; keep only the two newest images to stay inside the 0.5 GB free storage.
gcloud artifacts repositories create necrolegacy --repository-format=docker --location="$REGION"
cat > /tmp/cleanup.json <<'EOF'
[
  {"name": "keep-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"olderThan": "1d"}}
]
EOF
gcloud artifacts repositories set-cleanup-policies necrolegacy --location="$REGION" --policy=/tmp/cleanup.json

# Secrets. `read -rs` keeps each value out of the terminal and shell history; printf stores it without a
# trailing newline (a newline at the end of a URL breaks the connection).
# The Neon string comes straight from .env.local (written by `neon deploy`), so it is never pasted or shown.
sed -n 's/^DATABASE_URL_UNPOOLED=//p' .env.local | tr -d '"\n' | gcloud secrets create necro-db-url --data-file=-
read -rs "REDIS_URL?Upstash rediss:// URL: " && echo
printf '%s' "$REDIS_URL" | gcloud secrets create necro-redis-url --data-file=-
read -rs "LLM_KEY?AxForge API key: " && echo
printf '%s' "$LLM_KEY" | gcloud secrets create necro-llm-key --data-file=-
unset DB_URL REDIS_URL LLM_KEY
# If a secret already exists (or a value was wrong), add a new version instead of creating it; deploys read
# `latest`. For example, from the repo root:
#   sed -n 's/^DATABASE_URL_UNPOOLED=//p' .env.local | tr -d '"\n' | gcloud secrets versions add necro-db-url --data-file=- --project "$PROJECT_ID"

# Runtime identity: may only read those secrets.
gcloud iam service-accounts create necro-api --display-name="NecroLegacy API runtime"
RUNTIME_SA="necro-api@$PROJECT_ID.iam.gserviceaccount.com"
for s in necro-db-url necro-redis-url necro-llm-key; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor
done

# Deploy identity for GitHub Actions, reached through Workload Identity Federation (no key files).
gcloud iam service-accounts create necro-deployer --display-name="NecroLegacy GitHub deployer"
DEPLOY_SA="necro-deployer@$PROJECT_ID.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role=roles/run.admin
gcloud artifacts repositories add-iam-policy-binding necrolegacy --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

Then add a budget alert in the console under **Billing > Budgets & alerts**, for example $5 with emails at 50% and
100%. Budgets are free, but they only alert; they never stop spending.

## 3. GitHub repository variables

```sh
gh variable set GCP_PROJECT_ID --body "$PROJECT_ID"
gh variable set GCP_REGION --body "$REGION"
gh variable set GCP_WIF_PROVIDER --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
gh variable set GCP_DEPLOY_SA --body "$DEPLOY_SA"
gh variable set GCP_RUNTIME_SA --body "$RUNTIME_SA"
gh variable set WEB_ORIGIN --body "https://necrolegacy-web.onrender.com"   # the Render URL from step 5
```

Optional overrides: `LLM_BASE_URL` (default `https://api.axforge.ai/v1`), `LLM_PRIMARY_MODEL` (default
`qwen3.8-flash-next`), `LLM_PRIMARY_VISION` (default `true`), `LLM_FALLBACK_MODEL` (default `qwen3.8-27b`) and
`LLM_PRIMARY_REASONING_EFFORT` / `LLM_FALLBACK_REASONING_EFFORT` (default unset). For a text-only primary such as
Groq's `openai/gpt-oss-120b`, set `LLM_PRIMARY_VISION=false` so images go straight to the fallback. None of these
are secrets; secrets stay in Secret Manager.

## 4. Deploy the API

Run **Actions > deploy-api > Run workflow**. After that, every push to `main` that passes CI redeploys
automatically. The API URL is `https://necrolegacy-api-$PROJECT_NUMBER.$REGION.run.app`.

## 5. Deploy the web app

In Render, choose **New > Blueprint**, pick the repository, and enter that API URL as `NEXT_PUBLIC_API_URL`. If
Render gives the site a different URL from the one in `WEB_ORIGIN`, update the variable and run `deploy-api` again.

## Costs

Measured on the presets: one LLM call per text autopsy (about 1,000 input tokens, 1,000 to 3,000 output tokens,
capped at 4,096), about 1.1 GB peak memory, about 2 KB of Postgres per record (deleted after 24 hours) and a
handful of Redis commands.

| Item | Per autopsy | Free capacity a month | After the free tier |
|---|---|---|---|
| Cloud Run (1 vCPU, 2 GiB, about 10 s with the stream open) | about 10 vCPU-s and 20 GiB-s | about 18,000 autopsies | about $0.0003 per autopsy; continuous use is about $0.10 an hour |
| AxForge `qwen3.8-flash-next` | 2,000 to 4,000 tokens; a scan adds about 1,500 to 4,000 | about 750 to 1,500 autopsies a month | paid from a prepaid balance; with no balance, calls fail with 402 and nothing is charged |
| Neon | about 1 MB for a preset, kept 24 hours | 1 GB at once | paid plans from $0.106 per compute-hour |
| Upstash | about 10 commands | about 50,000 autopsies | $0.20 per 100,000 commands |
| Artifact Registry | none | 0.5 GB (two images) | $0.10 per GB-month |
| Render static site | none | free | — |

When the LLM allowance runs out, autopsies still finish: the deterministic and ML findings are unaffected and the
LLM explanations are marked skipped. The faded dot-matrix preset reads poorly with tesseract (mean confidence about
0.35), so it asks the vision model first; if that model is missing, rate-limited or returns nothing, the API keeps
the local OCR cells and the Vision X-Ray marks most of them low-confidence. For comparison, the Bedrock setup costs about $0.002 per autopsy with
`gpt-oss-120b` and about $0.03 to $0.07 when the Claude Sonnet 4.5 fallback answers.
