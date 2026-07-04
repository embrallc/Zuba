# Environments & Deploy Runbook — Zanbi

How the backend is split across **local → staging → production**, what secrets
live where, and the exact steps to set up and operate each environment.

## Topology

| Env | Supabase | App build | Worker | form-editor | Third-party |
|-----|----------|-----------|--------|-------------|-------------|
| **local** | CLI/Docker (`supabase start`) on your machine | `expo start` + `.env.local` | optional local node | `vite dev` (mock mode) | test/sandbox |
| **staging** | `zuba-staging` project (same org) | EAS `preview` build | Railway service (staging) | Cloudflare Pages (staging) | Stripe **test** / RC sandbox |
| **production** | current project `wwspvjsnkkgdziixbeei` (same org) | EAS `production` build | Railway service (prod, existing) | Cloudflare Pages (prod) | Stripe **live** / RC production |

**Source of truth = migrations.** No more dashboard SQL. Every schema change is a
committed file in `supabase/migrations/`. `main` auto-deploys to **staging**; a
tagged release (`v*`) deploys to **production** behind a manual approval gate.

Future: when real users arrive, split staging/prod into **separate orgs**.

---

## API keys (new Supabase key system)

Every project — local, staging, prod — uses the **new API key system**. Two
formats, and only these:

- **`sb_publishable_…`** — public, safe in the app bundle. This is what
  `EXPO_PUBLIC_SUPABASE_KEY` carries. RLS is the security boundary; the
  publishable key grants nothing on its own.
- **`sb_secret_…`** — service-role, **server-only**, bypasses RLS. Lives in the
  Railway worker (`SUPABASE_SERVICE_ROLE_KEY`), the pg_cron Vault entry
  (`service_role_key`), and is auto-injected into Edge Functions as
  `SUPABASE_SERVICE_ROLE_KEY`. Never ships to a client, never committed.

The **legacy JWT keys** (`anon` / `service_role`, the long `eyJ…` tokens) are
deprecated and must be **disabled** on every project (see the one-time setup
steps). The API gateway accepts both formats, but our functions check
`jwt === SUPABASE_SERVICE_ROLE_KEY` for internal calls — so every external holder
of the service key MUST use the `sb_secret_…` value (a legacy JWT reaches the
function but fails the `===` check → 401).

Get the values from **Dashboard → Project Settings → API Keys** (reveal the
secret key). Rotating the secret means updating every holder at once — see the
rotate runbook.

---

## Prerequisites

- **Supabase CLI** (`npx supabase`, v2.107+ already used here).
- **Docker Desktop** — required for local dev (`supabase start`). On Windows use the WSL2 backend. *(Not yet installed on this machine — install before Phase 1.)*
- A **Supabase personal access token**: https://supabase.com/dashboard/account/tokens (used by CI as `SUPABASE_ACCESS_TOKEN`).

---

## Local development

```bash
# 1. Start the local stack (Postgres/Auth/Storage/Studio/Edge runtime).
npm run sb:start            # → prints local API URL + anon key + Studio URL

# 2. Build the schema from migrations + load the seed (idempotent; re-run anytime).
npm run sb:reset            # applies all migrations, then supabase/seed.sql

# 3. (optional) Run Edge Functions locally with their secrets.
cp supabase/functions/.env.example supabase/functions/.env   # then fill test keys
npm run sb:serve

# 4. Point the app at local. Copy .env.example → .env.local and set:
#    EXPO_PUBLIC_SUPABASE_URL = http://<your-LAN-IP>:54321   (LAN IP, not localhost,
#                                                             so a physical device can reach it)
#    EXPO_PUBLIC_SUPABASE_KEY = <anon key from sb:start output>
npm start
```

Seed login: **dev@zuba.test / password123** (or just sign up in-app against local).

Author a migration after changing schema locally:
```bash
npm run sb:diff -- -f my_change   # writes supabase/migrations/<ts>_my_change.sql
```
Commit it. Never edit a project's schema in the dashboard.

---

## One-time setup: STAGING

1. **Create project** `zuba-staging` in the existing org (Supabase dashboard).
2. **GitHub config** (repo → Settings → Secrets and variables → Actions):
   - Variable `STAGING_PROJECT_ID` = staging project ref.
   - Secret `STAGING_DB_PASSWORD` = staging DB password.
   - Secret `SUPABASE_ACCESS_TOKEN` = your access token (shared by both workflows).
   - Create a GitHub **Environment** named `staging`.
3. **First deploy:** push to `main` (or run the *Deploy Staging (Supabase)* workflow manually). It runs `db push` + `functions deploy`.
4. **Seed Edge Function secrets** (once) — see the Secret matrix below:
   ```bash
   supabase secrets set --project-ref <STAGING_REF> \
     STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
     RESEND_API_KEY=re_... REPORT_FROM_EMAIL=reports@... \
     GOOGLE_ROUTES_API_KEY=... GEMINI_API_KEY=... \
     REVENUECAT_SECRET_API_KEY=... RC_WEBHOOK_SECRET=... \
     EDITOR_APP_URL=https://<staging-pages-url> DEV_BYPASS_EMAILS=you@example.com
   ```
   `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in the cloud.
5. **Vault + cron** (once, in staging SQL editor) — the reconcile sweep needs them:
   ```sql
   select vault.create_secret('https://<STAGING_REF>.supabase.co', 'project_url', '');
   select vault.create_secret('<STAGING_SERVICE_ROLE_KEY>', 'service_role_key', '');
   ```
6. **Railway worker (staging):** new service from `report-worker/`, Root Directory `report-worker`, env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (staging) + `REPORT_BUCKET=inspection-reports`. Capture its URL.
7. **form-editor (staging):** set `form-editor/.env.staging` `VITE_API_BASE` to the staging function URL, then `npm run editor:deploy:staging`. Set `EDITOR_APP_URL` staging secret (step 4) to the resulting Pages URL.
8. **Webhooks (staging):** register Stripe **test** + RevenueCat **sandbox** webhooks → staging function URLs (`https://<STAGING_REF>.supabase.co/functions/v1/{stripe-connect-webhook,revenuecat-webhook}`).
9. **App EAS env (preview → staging):**
   ```bash
   eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value https://<STAGING_REF>.supabase.co --visibility plaintext
   eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_KEY --value <staging publishable key> --visibility plaintext
   eas env:create --environment preview --name EXPO_PUBLIC_REPORT_WORKER_URL --value <staging worker URL> --visibility plaintext
   ```
   Build: `eas build --profile preview`.
10. **Disable legacy keys:** Dashboard → API Keys → Legacy API keys → disable
    `anon` + `service_role`. Staging only ever used the new keys, so this is a
    no-op safety lock — confirm nothing references a JWT first.

---

## One-time setup: PRODUCTION (repurpose current project)

1. **Reconcile drift → migrations are authoritative:**
   ```bash
   supabase link --project-ref wwspvjsnkkgdziixbeei
   supabase db pull        # writes a catch-up migration if the live schema differs
   ```
   Review/commit any generated migration. (The `inspection-images` bucket drift is already fixed in `20260623000000_*`.)
2. **GitHub config:** variable `PROD_PROJECT_ID` = `wwspvjsnkkgdziixbeei`; secret `PROD_DB_PASSWORD`; create a GitHub **Environment** `production` with **required reviewers** (the approval gate).
3. **Secrets are already set** on this project (live Stripe/Resend/etc.). Keep them LIVE.
4. **Deploy** by tagging a release: `git tag v1.x.y && git push --tags` → approve the *Deploy Production* workflow.
5. **App EAS env (production):** `eas env:create --environment production ...` with the prod URL, prod publishable key, prod worker URL. Build `eas build --profile production`.
6. **Migrate off legacy keys** (one-time hardening — prod predates the new key system):
   - Railway prod worker: set `SUPABASE_SERVICE_ROLE_KEY` = prod `sb_secret_…`, redeploy, check `/health` → `configured:true` and run one report.
   - Confirm Vault `service_role_key` = prod `sb_secret_…` (the cron-401 fix already did this) and EAS prod `EXPO_PUBLIC_SUPABASE_KEY` = prod `sb_publishable_…` (app already uses it).
   - Then Dashboard → API Keys → **Legacy API keys → disable** `anon` + `service_role`. (No real users; any stale build baked with a legacy anon JWT would stop working — rebuild it with the publishable key.)

---

## Secret × environment matrix

PUBLIC (safe in app bundle / committed config) — never the service-role key:

| Var | Where it lives |
|-----|----------------|
| `EXPO_PUBLIC_SUPABASE_URL` | EAS env (preview/production), `.env.local` (local) |
| `EXPO_PUBLIC_SUPABASE_KEY` (anon/publishable) | EAS env, `.env.local` |
| `EXPO_PUBLIC_REPORT_WORKER_URL` | EAS env, `.env.local` |
| `VITE_API_BASE` (form-editor) | `form-editor/.env.production` / `.env.staging` (committed; public URL) |

SERVER-SIDE secrets — set per Supabase project via `supabase secrets set` (cloud) or `supabase/functions/.env` (local). Never committed:

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `REPORT_FROM_EMAIL`,
`GOOGLE_ROUTES_API_KEY`, `GEMINI_API_KEY`, `REVENUECAT_SECRET_API_KEY`,
`RC_WEBHOOK_SECRET`, `EDITOR_APP_URL`, `DEV_BYPASS_EMAILS`. (`SUPABASE_URL` /
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are auto-injected in the cloud.)

Vault (per project, for pg_cron reconcile sweep): `project_url`, `service_role_key`.

Worker (Railway env, per service): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REPORT_BUCKET`, `SIGNED_URL_TTL`.

GitHub Actions: `SUPABASE_ACCESS_TOKEN`, `STAGING_DB_PASSWORD`, `PROD_DB_PASSWORD` (secrets); `STAGING_PROJECT_ID`, `PROD_PROJECT_ID` (variables).

**Third-party per env:** prod = **live/isolated**; local + staging = **test/sandbox** (shared test creds OK while there are no users). Stripe live↔test is a hard split (separate keys + separate webhooks). RevenueCat sandbox vs production. Google/Resend may share a key initially (watch cost attribution) but get separate keys before launch. **Webhooks are per-project URLs** — register Stripe + RevenueCat separately for staging and prod.

---

## Routine runbooks

- **Ship a schema/function change:** branch → edit migrations/functions → PR → merge to `main` → auto-deploys to staging → QA → `git tag vX.Y.Z && git push --tags` → approve prod deploy.
- **Add an Edge Function secret:** `supabase secrets set --project-ref <ref> NAME=value` for each env; add to `supabase/functions/.env.example`; document it here.
- **Rotate the service-role key:** update Railway worker env + Vault `service_role_key` + any GitHub secret that holds it.
- **Rollback:** migrations are forward-only. To undo, write a new compensating migration and deploy. For prod data recovery, restore from Supabase backups (enable PITR before launch).

## Future / optional

- **Doppler or 1Password** to centralize secret sync across local/staging/prod/Railway/EAS instead of hand-copying.
- Split staging/prod into separate **orgs** once there are real users.
- GitHub Actions for the **app (EAS)**, **worker (Railway)**, and **form-editor (Cloudflare)** to round out CI (deferred — those deploy manually for now).
