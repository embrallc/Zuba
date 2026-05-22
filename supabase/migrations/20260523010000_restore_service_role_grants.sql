-- ─────────────────────────────────────────────────────────────────────────────
-- Restore standard Supabase service_role privileges on the public schema.
--
-- The `delete-account` and `reassign-inspection` Edge Functions run with the
-- service role and need full access to every public table, sequence, and
-- function. A "permission denied for table users (42501)" failure on a
-- service-role query indicates these grants were not in place.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Keep future objects accessible too so we don't have to re-grant after every
-- new migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
