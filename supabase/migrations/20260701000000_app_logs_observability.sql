-- Observability: extend app_logs into the device + server telemetry sink.
--
-- app_logs was created in 20260622000000 as an unused, service-role-only
-- placeholder (the Railway worker's logToCloud is its only writer so far). This
-- migration:
--   1. Adds the columns device + EF telemetry needs (event, data, device/app
--      metadata, a client-generated log_sk for idempotent batch upserts).
--   2. Opens an INSERT-ONLY path for the signed-in app: an RLS policy +
--      GRANT INSERT so a device can append ITS OWN rows (auth.uid() = user_id).
--      Still NO select/update/delete for authenticated → append-only + private.
--      The owner reads via the dashboard / service role.
--   3. Adds query indexes + two convenience views (security_invoker so they
--      never leak past RLS).
--
-- Levels shipped from prod: 'error' | 'warn' | 'event'. Events are dot-namespaced
-- 'domain.outcome' (e.g. sync.completed / sync.failed); failures end in '.failed'.

-- ── New columns (additive; safe to re-run) ───────────────────────────────────
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS log_sk        TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS org_sk        TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS event         TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS data          JSONB;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS platform      TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS app_version   TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS device_model  TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS os_version    TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS session_id    TEXT;
ALTER TABLE public.app_logs ADD COLUMN IF NOT EXISTS client_ts     TIMESTAMPTZ;

-- log_sk is the device-side LogSk (the local AppLogs primary key). Unique so a
-- retried batch upserts instead of duplicating. NULLs are distinct in Postgres,
-- so server-side rows (worker/EFs) that omit log_sk are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS app_logs_log_sk_key ON public.app_logs (log_sk);

-- ── Query indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS app_logs_org_created_idx   ON public.app_logs (org_sk, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_level_created_idx ON public.app_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_user_created_idx  ON public.app_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_event_created_idx ON public.app_logs (event, created_at DESC)
  WHERE event IS NOT NULL;

-- ── Device insert path (append-only, own rows only) ──────────────────────────
DROP POLICY IF EXISTS app_logs_insert_own ON public.app_logs;
CREATE POLICY app_logs_insert_own ON public.app_logs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- INSERT only. No SELECT/UPDATE/DELETE grant → authenticated devices can append
-- but never read (their own or others') or mutate. Service role keeps full access.
GRANT INSERT ON public.app_logs TO authenticated;

-- ── Convenience views (dashboard/service-role querying) ──────────────────────
-- security_invoker = on so the view runs with the caller's privileges; since
-- authenticated has no SELECT on app_logs, these are effectively service-role
-- only, same as querying the table directly.

-- Recent failures (last 7 days).
CREATE OR REPLACE VIEW public.v_app_errors_recent
  WITH (security_invoker = on) AS
  SELECT created_at, level, source, context, message, event,
         user_id, org_sk, platform, app_version, device_model, os_version, session_id
  FROM public.app_logs
  WHERE level IN ('error', 'warn')
    AND created_at > now() - interval '7 days'
  ORDER BY created_at DESC;

-- Per-day process health: success vs failure counts per event domain
-- (failures = events ending in '.failed').
CREATE OR REPLACE VIEW public.v_process_health_daily
  WITH (security_invoker = on) AS
  SELECT (created_at AT TIME ZONE 'UTC')::date           AS day,
         split_part(event, '.', 1)                       AS domain,
         count(*) FILTER (WHERE event NOT LIKE '%.failed') AS successes,
         count(*) FILTER (WHERE event LIKE '%.failed')     AS failures,
         count(*)                                          AS total
  FROM public.app_logs
  WHERE event IS NOT NULL
  GROUP BY 1, 2
  ORDER BY 1 DESC, 2;
