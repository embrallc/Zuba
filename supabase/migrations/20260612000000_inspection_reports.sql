-- ─────────────────────────────────────────────────────────────────────────────
-- Generated inspection reports: private storage bucket + tracking table
-- Apply via: npx supabase db push
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per generated PDF. Latest report for an inspection = max(generated_at).
-- History is kept (storage is cheap, regulatory trail is useful); pruning can
-- come later.
CREATE TABLE IF NOT EXISTS inspection_reports (
  report_sk     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_sk TEXT NOT NULL REFERENCES inspections(inspection_sk) ON DELETE CASCADE,
  org_sk        UUID,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_path  TEXT NOT NULL,
  page_count    INTEGER,
  size_bytes    BIGINT,
  generated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspection_reports_inspection
  ON inspection_reports(inspection_sk, generated_at DESC);

-- Service-role only — written by the generate-report edge function; the app
-- receives a signed URL in the function response.
ALTER TABLE inspection_reports ENABLE ROW LEVEL SECURITY;

-- Private bucket for the PDFs. No storage RLS policies on purpose: only the
-- service role (edge function) reads/writes; clients download via short-lived
-- signed URLs.
INSERT INTO storage.buckets (id, name, public)
VALUES ('inspection-reports', 'inspection-reports', false)
ON CONFLICT (id) DO NOTHING;
