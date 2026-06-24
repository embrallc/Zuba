-- ─────────────────────────────────────────────────────────────────────────────
-- Drift reconciliation: create the `inspection-images` Storage bucket.
--
-- The bucket's RLS policies were added in migrations (20260521010000, fixed to
-- the correct id in 20260521030000), but the bucket itself was only ever
-- created by hand in the dashboard — it was never INSERTed by a migration. So a
-- fresh project (local, staging, a rebuilt prod) would have the policies but no
-- bucket, breaking photo upload/download.
--
-- This makes migrations the source of truth for the bucket too. Idempotent: a
-- no-op on the current prod project (where the bucket already exists). Private
-- bucket — inspection photos are client PII; the app reaches them via the
-- owner-scoped RLS above, and the report worker via the service role.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('inspection-images', 'inspection-images', false)
ON CONFLICT (id) DO NOTHING;
