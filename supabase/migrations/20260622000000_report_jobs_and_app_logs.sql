-- Cloud Run PDF worker: job tracking + cloud error logs.
--
-- report_jobs — one row per report-generation request. The APP inserts the row
-- (RLS: own rows only), subscribes to it via Supabase Realtime, then calls the
-- Cloud Run worker. The worker (service role, bypasses RLS) flips status and
-- writes report_url/storage_path on success or error on failure.
--
-- app_logs — server-side error sink the worker writes to (service role only).
-- The device→cloud log sync is a separate pre-launch task; this just creates
-- the table the worker logs into now.

-- ── report_jobs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_sk TEXT NOT NULL,
  org_sk        UUID,
  user_id       UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  report_url    TEXT,
  storage_path  TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS report_jobs_user_id_idx ON public.report_jobs (user_id);
CREATE INDEX IF NOT EXISTS report_jobs_inspection_sk_idx ON public.report_jobs (inspection_sk);

ALTER TABLE public.report_jobs ENABLE ROW LEVEL SECURITY;

-- A user may create + read ONLY their own jobs (this is what powers both the
-- insert and the Realtime subscription). No user UPDATE/DELETE — the worker
-- mutates rows via the service role, which bypasses RLS.
DROP POLICY IF EXISTS report_jobs_select_own ON public.report_jobs;
CREATE POLICY report_jobs_select_own ON public.report_jobs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS report_jobs_insert_own ON public.report_jobs;
CREATE POLICY report_jobs_insert_own ON public.report_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT ON public.report_jobs TO authenticated;
GRANT ALL ON public.report_jobs TO service_role;

-- Realtime: emit row changes to subscribed clients, and include the full row on
-- UPDATE (needed so RLS-filtered UPDATE events reach the owner).
ALTER TABLE public.report_jobs REPLICA IDENTITY FULL;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.report_jobs;
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already in the publication
END $$;

-- ── app_logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level      TEXT NOT NULL DEFAULT 'error',
  message    TEXT,
  context    TEXT,
  stack      TEXT,
  job_id     TEXT,
  user_id    UUID,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_logs_created_at_idx ON public.app_logs (created_at DESC);

-- Service-role only. RLS enabled with NO policies → anon/authenticated can't
-- read or write; the worker writes via the service role (bypasses RLS). Read it
-- via the Supabase SQL editor / dashboard.
ALTER TABLE public.app_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_logs FROM anon, authenticated;
GRANT ALL ON public.app_logs TO service_role;
