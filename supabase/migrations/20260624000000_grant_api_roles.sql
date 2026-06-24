-- ─────────────────────────────────────────────────────────────────────────────
-- Grant the Data API roles (anon, authenticated, service_role) access to the
-- public schema — explicitly and in version control.
--
-- Why: the original prod project was created when Supabase auto-exposed new
-- tables to these roles, so our migrations never granted privileges explicitly.
-- Newer projects (zuba-staging, local dev, any future env) ship with the new
-- default where tables are NOT auto-exposed — so a fresh deploy has the schema
-- but the API roles get "permission denied for table" (42501). This makes the
-- grants explicit so EVERY environment matches prod.
--
-- RLS remains the security boundary — every app table enables RLS, so anon /
-- authenticated are still gated at the row level; these are only base table
-- privileges (PostgREST requires both the GRANT and an RLS policy to return
-- rows). Idempotent: a no-op on prod, which already has these via the legacy
-- default. Mirrors Supabase's own default-privileges setup.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing objects.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Future objects created in public (by the migration-running role) — so new
-- tables in later migrations are auto-granted and we never hit this again.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
