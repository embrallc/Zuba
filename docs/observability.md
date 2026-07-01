# Observability — querying logs & telemetry from the cloud

Once the app is live, you watch its health from the **Supabase SQL editor** (staging or prod project).
Everything lands in one table: **`public.app_logs`**. This doc covers what's captured, how it gets
there, and the queries to run.

## What's captured

| Kind | How | Where it's emitted |
| --- | --- | --- |
| **Errors** (`level='error'`) | every `logError(e, context)` call (~288 sites) | catches across the app |
| **Catch-all errors** | global handler + React error boundary | `utils/globalErrorHandler.js`, `components/AppErrorBoundary.jsx` |
| **Warnings** (`level='warn'`) | `logWarn(msg, context)` | as needed |
| **Process events** (`level='event'`) | `logEvent(name, data)` | success/failure milestones |
| **Server events/errors** | Edge Functions + Railway worker | `supabase/functions/_shared/logToCloud.ts`, `report-worker/lib/jobs.js` |

**Prod ships only `error`, `warn`, `event`.** `info`/`debug` are console-only (see "Tuning" below).

### The catch-all net (nothing escapes unlogged)
Three layers, all funneling into `app_logs`, each tagged so you can query them:
- `context = 'globalError'` / `'globalError:fatal'` — uncaught JS errors (event handlers, timers).
- `context LIKE 'unhandledRejection%'` — rejected promises with no `.catch`.
- `context = 'react:errorBoundary'` — a component threw during render (carries `data.componentStack`).

### Event taxonomy (`event` column)
Dot-namespaced `domain.outcome`; **failures end in `.failed`**. `data` (jsonb) holds ids/counts/
durations only — never customer PII.

`sync.completed {durationMs,inspections,forms,…}` · `sync.failed {durationMs,reason}` ·
`report.generated {sk,source,durationMs}` · `report.failed {sk,source,reason}` ·
`autosend.sent {inspectionSk}` · `autosend.failed {inspectionSk,detail}` · `autosend.held` ·
`autosend.skipped {reason}` · `reminder.sent {sent,failed}` · `reminder.failed` ·
`reminder.replied {action}` · `auth.signin` · `auth.signup` · `inspection.completed {sk}` ·
`photo.uploaded {count}` · `airewrite.success` · `calendar.synced {imported,deleted,known}` ·
`payment.requested {sk,amountCents}`.

## How it gets to the cloud (pipeline)

```
device:  logError/logWarn/logEvent ─► local SQLite AppLogs (Synced=0, the offline queue)
                                          │  utils/logShipper.js: batched upsert every ~30s,
                                          │  on reconnect, and on background  (append-only, RLS)
                                          ▼
                                     cloud public.app_logs ◄── Edge Functions + Railway worker
                                          │                    (service role, _shared/logToCloud.ts)
                                          ▼
                              Supabase SQL editor / dashboard (you)
```

- **Append-only + private**: devices can `INSERT` their own rows (`auth.uid() = user_id`) but cannot
  read or modify `app_logs`. You read it via the dashboard (service role).
- **Offline-safe**: the local `AppLogs` table is the durable queue; rows flip `Synced=1` once shipped.
  Synced rows are pruned locally after 7 days / a 5000-row cap (`utils/logShipper.js`).
- **Retention**: a nightly `pg_cron` job (`prune_app_logs`, 03:30 UTC) deletes cloud rows older than
  **60 days** (`supabase/migrations/20260701000100_app_logs_retention.sql`).

## Schema (`public.app_logs`)
`id, log_sk, level, event, message, context, stack, data (jsonb), job_id, user_id, org_sk, source,
session_id, platform, app_version, device_model, os_version, client_ts, created_at`.
`source`: `'app'` (device), `'ef:<name>'` (Edge Function), `'report-worker'` (worker).

## Canonical queries

Two convenience views ship with the migration: **`v_app_errors_recent`** (last 7 days of error/warn)
and **`v_process_health_daily`** (per-day success vs failure by domain).

```sql
-- Recent failures
select * from v_app_errors_recent limit 200;

-- Per-day process health (successes vs failures by domain)
select * from v_process_health_daily;

-- Errors per day
select date_trunc('day', created_at) as day, level, count(*)
from app_logs where level in ('error','warn')
group by 1,2 order by 1 desc;

-- Top error sites in the last week
select context, count(*) as n, max(created_at) as last_seen
from app_logs where level='error' and created_at > now() - interval '7 days'
group by context order by n desc limit 30;

-- Which users are hitting the most errors
select user_id, count(*) as errors, max(created_at) as last_seen
from app_logs where level='error' and created_at > now() - interval '7 days'
group by user_id order by errors desc;

-- The app-level catch-all (uncaught / unhandled / render crashes)
select created_at, context, message, platform, app_version, data->>'componentStack' as stack
from app_logs
where context in ('globalError','globalError:fatal','react:errorBoundary')
   or context like 'unhandledRejection%'
order by created_at desc limit 100;

-- Slowest syncs
select created_at, (data->>'durationMs')::int as ms, user_id, data
from app_logs where event='sync.completed'
order by ms desc nulls last limit 50;

-- Auto-send failures with the reason
select created_at, data->>'inspectionSk' as sk, data->>'detail' as detail
from app_logs where event='autosend.failed' order by created_at desc limit 100;

-- Follow one app session end-to-end
select created_at, level, event, context, message
from app_logs where session_id = '<session_id>' order by created_at;

-- Sanity: was the cloud sink written at all today?
select source, count(*) from app_logs
where created_at > now() - interval '1 day' group by source;
```

## Tuning

- **Levels shipped**: `PERSIST_LEVELS` in `db/logs.js` (`error|warn|event`). Add `'info'` there to
  capture info too (raises volume).
- **Ship cadence / batch size / local cap**: constants at the top of `utils/logShipper.js`.
- **Cloud retention window**: the `interval '60 days'` in `prune_app_logs()`
  (`supabase/migrations/20260701000100_app_logs_retention.sql`) — change + add a new migration.

## File map
- `db/logs.js` — `logError` / `logWarn` / `logEvent`, session id + device metadata, level gate.
- `db/index.js` — local `AppLogs` buffer columns (`Event`, `Data`, `SessionId`, `Synced`).
- `utils/logShipper.js` — batched offline shipper (start/stop wired in `app/_layout.jsx`).
- `utils/globalErrorHandler.js` + `components/AppErrorBoundary.jsx` — the catch-all net.
- `supabase/functions/_shared/logToCloud.ts` — EF telemetry helper.
- `supabase/migrations/20260701000000_app_logs_observability.sql` — table extension, insert RLS, views.
- `supabase/migrations/20260701000100_app_logs_retention.sql` — nightly prune cron.

## Follow-ups (not built)
- Optional **Sentry** for symbolicated native crash stacks — a seam is left in `utils/logShipper.js`.
- Owner-facing in-app "System health" screen; alerting cron on error-rate spikes; Log Drains / OTel
  export if volume outgrows a single table.
