# Zuba Report Worker (Cloud Run)

Node/Express service that generates inspection report PDFs off the Supabase Edge
Function (which is capped at 256 MB memory). The app creates a `report_jobs`
row, subscribes to it via Supabase Realtime, then calls this worker directly
with the user's Supabase JWT. The worker validates the JWT, responds **202**
immediately, and generates the PDF **detached** in the background — uploading to
the private `inspection-reports` bucket and flipping the `report_jobs` row to
`completed` (or `failed`).

> Status: **mock PDF**. The real renderer (ported from the `generate-report`
> Edge Function + `sharp` image downscaling) lands in a follow-up.

## Endpoint

```
POST /api/generate-report
  Header: Authorization: Bearer <user Supabase JWT>
  Body:   { "jobId": "...", "inspectionId": "...", "orgId": "..." }
  → 202 { jobId, status: "processing" }   (work continues in the background)

GET /health → 200 { ok: true }
```

Responses: `400` missing fields / mismatch · `401` bad JWT · `403` not your job ·
`404` job not found.

## Env

See `.env.example`. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(the `sb_secret_…` key — server-only, bypasses RLS). Optional: `REPORT_BUCKET`,
`SIGNED_URL_TTL`, `PORT`.

## Run locally

```bash
cp .env.example .env   # fill in the service-role key
npm install
node --env-file=.env index.js
# then: curl localhost:8080/health
```

## Deploy to Cloud Run

From the repo root (Cloud Build builds the Dockerfile):

```bash
gcloud run deploy report-worker \
  --source ./report-worker \
  --region us-central1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --memory 1Gi \
  --min-instances 0 \
  --set-env-vars REPORT_BUCKET=inspection-reports,SIGNED_URL_TTL=604800 \
  --set-secrets SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest
```

Notes:
- **`--no-cpu-throttling` is required.** Without it Cloud Run freezes CPU the
  instant the 202 is sent, so the detached PDF work never completes. The service
  still scales to zero.
- **`--allow-unauthenticated` is intentional.** The endpoint authenticates the
  Supabase **JWT** itself; the service-role key lives only inside the container.
- Store `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in **Secret Manager**
  (`gcloud secrets create …`) and reference them with `--set-secrets`, or use
  `--set-env-vars` for non-secret values.
- After deploy, copy the service URL into the app as
  `EXPO_PUBLIC_REPORT_WORKER_URL`.

## Verify

```bash
# Create a report_jobs row in Supabase (SQL editor) for one of your inspections,
# grab its id, then:
curl -i -X POST "$WORKER_URL/api/generate-report" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"<id>","inspectionId":"<inspection_sk>","orgId":"<org_sk>"}'
# → 202, and the report_jobs row flips pending→processing→completed with report_url.
```
