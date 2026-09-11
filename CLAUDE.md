# Zanbi — Build, Test & Deploy Workflow

Operational guide for getting code onto devices and into staging/prod **without
interrupting production**. Full infra runbook lives in
[docs/environments.md](docs/environments.md); this is the day-to-day playbook.

Stack: Expo managed (SDK 54, RN 0.81, React 19), JS only (`.jsx`/`.js`); Supabase
backend (local/staging/prod); Cloudflare Pages (`form-editor/`, site); Railway
report-worker; Resend email; EAS builds/updates.

---

## 🛡️ Standing engineering principles (apply to EVERY feature, always)

These are non-negotiable defaults for all planning and code — not per-request opt-ins.

1. **Prioritize security in planning new features.** Before writing code, think through
   the security surface: who can call it, what data it exposes, and how it's abused.
   Default to least privilege (RLS + explicit grants, never `anon`; validate/authorize
   server-side, never trust the client; secrets stay server-side and out of git;
   BYO-keys/tokens encrypted at rest, never synced to the device). Call out the security
   implications in the plan itself.
2. **Prioritize robust function writing — error handling + proper logging.** Write
   functions that fail safely and observably: handle the error paths (network, auth,
   null/empty, provider/API failures, offline), never swallow errors silently, and log
   with enough context to diagnose in prod (via the existing logError / app_logs and EF
   logging patterns). Prefer graceful degradation over crashes; make failures traceable.

---

## ⭐ Main process — Dev → Prod (the canonical loop)

**Iterate & test on the Dev build; release with a Production build. Skip the
standalone Staging TestFlight build** — it caused more trouble than it's worth
(fingerprint drift, submit/processing delays that never surfaced in TestFlight).
Keep it only as an *optional* release-candidate check, not part of the normal loop.

1. **Build the Dev build once** — `eas build --profile development --platform ios`
   → install **Zanbi (Dev)**. Rebuild only on a **native** change (see fingerprint rule).
2. **Iterate + test** — `npx expo start --tunnel` → open **Zanbi (Dev)**. Live reload +
   Fast Refresh, pointed at the **staging** backend (Stripe **test** mode). All feature
   testing happens here. Use **`--tunnel`** — this PC has virtual network adapters
   (VirtualBox/WSL/Hyper-V) that otherwise hide Metro from the phone ("no development
   servers running"). ⚠️ A Dev build must be **current** — if it predates a native
   change (added module/plugin), rebuild it, or current JS crashes on boot (e.g. an
   old build lacking the Sentry native module).
3. **Deploy the backend** — merge PR to `main` (→ **staging** auto-deploys). When
   verified, `git tag vX.Y.Z && git push --tags` → approve the gated `supabase-prod`
   run → prod EFs + migrations.
4. **Release the app** — `eas build --profile production` → `eas submit --profile
   production` → install from **TestFlight internal** for a final standalone smoke test
   on prod → release. JS-only hotfix to a live build: `npm run ota:prod` (fingerprint
   permitting).

**Dev for all testing, Production for shipping.** The three-app detail below is
reference; this is the loop.

## Three apps — coexist on one device, never interfere

Different bundle-id suffixes (see [app.config.js](app.config.js)), so all three
install side by side. Icon label tells you which you're on.

| App label        | EAS profile          | Bundle id suffix | Backend                | JS updates via        | Use for |
|------------------|----------------------|------------------|------------------------|-----------------------|---------|
| **Zanbi (Dev)**  | `development`        | `.dev`           | **staging**            | **Metro (live)**      | day-to-day iteration |
| **Zanbi (Staging)** | `preview-testflight` | `.staging`     | staging (Stripe **test**) | **OTA** `ota:preview` | *optional* release-candidate check — **skipped in the main loop** |
| **Zanbi**        | `production`         | *(none)*         | prod (Stripe **live**) | OTA `ota:prod`        | the App Store app — **do not test on it** |

Testing on Dev/Staging never touches the prod app or prod data.

---

## Day-to-day loop: JS changes → Dev build + Metro (NO rebuild)

The Dev build (`developmentClient: true`) loads JS **live from Metro** with Fast
Refresh. **Never rebuild it for JS changes** — only for native ones (below).

1. `npx expo start` (use `npx expo start -c` after editing any `.env*` or switching
   git branches — env vars are inlined at bundler start, Fast Refresh won't re-read them).
2. Open **Zanbi (Dev)**, connect to your Metro server.
3. Edit JS → save → Fast Refresh. Points at the **staging** backend via
   `.env.development.local` (dev-mode-only, gitignored).

Build the Dev build **once**: `eas build --profile development --platform ios`
(install via internal distribution). Reuse it forever until a native change.

**"Is it actually on Metro?"** Reload the app → the `expo start` terminal must show
`Bundling ▓▓▓`. If it stays idle, the app is NOT talking to Metro (you opened a
standalone build, or it's not connected) — that's the #1 "old code" cause.

---

## Standalone / release-candidate check on staging → OTA

To exercise real standalone behavior (release build, no Metro) on the **Staging**
app:

```
npm run ota:preview -- --message "what changed"
```
(= `eas update --branch preview --environment preview --platform ios`)

Then force-close & reopen **Zanbi (Staging)** to pull the update. **No rebuild for
JS-only changes** — *if the fingerprint matches* (see below).

---

## Ship to prod

Client JS and server deploy on **separate tracks** — don't conflate them:

- **Backend (EFs + migrations):** `git tag vX.Y.Z && git push --tags` → approve the
  gated `supabase-prod` run at github.com/embrallc/Zuba/actions. (Merging a PR to
  `main` already auto-deploys the backend to **staging**.)
- **Railway report-worker:** deploys **manually** — not on merge. Redeploy the
  service after any `report-worker/**` change ([docs/environments.md](docs/environments.md)).
- **App:** `eas build --profile production` → `eas submit` → release. JS-only hotfix
  to an already-released build: `npm run ota:prod -- --message "…"` (fingerprint
  permitting).

⚠️ **Ship EF + matching client together.** A new EF against an old client can break
UX (e.g. old client doesn't understand a new response). If the client change can't
reach the live build by OTA (fingerprint drift), it rides the next build.

---

## Do we rebuild every time? NO. The fingerprint rule.

> **An `eas update` (OTA) only installs on a build whose fingerprint (runtimeVersion)
> MATCHES it.** `runtimeVersion` policy is `fingerprint`.

- Pure **JS / app-code** changes keep the fingerprint stable → OTA works, **no rebuild**.
- The fingerprint **changes** (→ old builds can no longer receive OTAs → **rebuild**) when:
  - a dependency is added/removed/bumped,
  - a native module or Expo **config plugin** changes,
  - `app.config.js` / `app.json` **native** fields change,
  - **`package.json` `scripts`** change *(non-obvious, but real — this orphaned the
    July Staging build's OTAs and forced the rebuild we're doing now)*,
  - Expo SDK / native runtime bump.

Check a match before relying on an OTA:
- `eas update …` prints `Runtime version <hash>` for the update.
- `eas build:list --platform ios --json` shows each build's `runtimeVersion`.
- They must be **equal**. If not, the OTA is orphaned — rebuild.

**Discipline:** keep the fingerprint stable (avoid gratuitous dep/script/native
churn) so a given build keeps receiving JS OTAs. Batch native-affecting changes so
you rebuild rarely (EAS free tier: 15 iOS + 15 Android/mo).

---

## Build gotchas (learned the hard way — don't repeat)

- **Sentry source-map upload HARD-FAILS a build** if `SENTRY_AUTH_TOKEN` is missing
  in that build's EAS environment (it is NOT a graceful skip). The **production** env
  has the token; the **preview** env now has **`SENTRY_DISABLE_AUTO_UPLOAD=true`** so
  staging builds don't need it. If a build dies on `Auth token is required` /
  `sentry-cli`, set `SENTRY_DISABLE_AUTO_UPLOAD=true` (skip) or
  `SENTRY_ALLOW_FAILURE=true` (try but don't fail) in that environment. *Durable
  hardening TODO: `SENTRY_ALLOW_FAILURE=true` on production so a token expiry can't
  break a release build.*
- **New App Store release needs a `version` bump**, not just a build number. Once a
  version train (e.g. 1.0.1) is released, that train is CLOSED — bump `app.json`
  `version` (CFBundleShortVersionString) for the next store release or `eas submit`
  is rejected (90062/90186). `appVersionSource: remote` auto-increments the *build*
  number only.
- **`eas update` defaults to `--platform all`** which bundles **web** and FAILS on
  `react-native-maps` — always pass `--platform ios` (the `ota:*` scripts already do).
- **EAS uses committed git state** for builds — an uncommitted `eas.json`/config edit
  won't take effect. Prefer `eas env:create --environment <env>` for build-time config
  (server-side, no commit needed), or commit the change first.

## Quick diagnostics for "I'm seeing old code"

1. **Which app?** Check the icon label — `(Dev)` / `(Staging)` / plain. If you meant
   to iterate but you're on `(Staging)`/plain, that's a standalone build (no Metro).
2. **Dev build:** does Metro show `Bundling` on reload? No → not connected; restart
   `npx expo start -c` and reconnect.
3. **Standalone build:** did you `ota:preview` / `ota:prod`, and does the update's
   runtimeVersion match the installed build's? Mismatch → rebuild.
4. **Report PDF / invoice email looks stale?** Those render **server-side**
   (Railway worker / Edge Functions) — client reload can't change them; redeploy the
   backend piece.

---

## Deploy cheat-sheet

| Goal | Command / action |
|---|---|
| Iterate on JS (staging) | `npx expo start` + **Zanbi (Dev)** |
| Push JS to Staging app | `npm run ota:preview -- --message "…"` |
| New Dev build (native change) | `eas build --profile development --platform ios` |
| New Staging build (fingerprint drift) | `eas build --profile preview-testflight --platform ios` → `eas submit --profile preview-testflight` |
| Deploy backend to **staging** | merge PR to `main` (auto) |
| Deploy backend to **prod** | `git tag vX.Y.Z && git push --tags` → approve gated run |
| New prod app build | `eas build --profile production --platform ios` → `eas submit --profile production` |
| JS hotfix to released prod | `npm run ota:prod -- --message "…"` (fingerprint permitting) |
| Redeploy report-worker | Railway dashboard (manual) after `report-worker/**` changes |
