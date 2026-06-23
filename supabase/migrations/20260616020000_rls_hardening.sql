-- Security hardening pass (2026-06-16). Three changes from the schema review:
--
--   1. Scope organizations SELECT to the caller's own org (was readable by every
--      authenticated user — cross-tenant disclosure of the full customer list).
--   2. Align inspection_forms SELECT with the inspections list policy so org
--      ADMINS (not just owners) can read teammates' forms.
--   3. Defense-in-depth: revoke anon/authenticated grants on the service-role-only
--      tables, so RLS being accidentally disabled later still can't expose them.
--
-- Written to be re-runnable (idempotent): policy DROP-then-CREATE on both old and
-- new names, and the revokes are guarded by to_regclass so a missing table (e.g.
-- api_cache, which was dropped from the live DB outside migrations) can't abort it.

-- ── 1. organizations: own-org SELECT only ────────────────────────────────────
DROP POLICY IF EXISTS "org_select_authenticated" ON public.organizations;
DROP POLICY IF EXISTS "org_select_own"           ON public.organizations;

CREATE POLICY "org_select_own"
  ON public.organizations FOR SELECT
  USING (org_sk::text = public.auth_uid_org_sk());

-- ── 2. inspection_forms: owner OR org owner/admin may read ────────────────────
DROP POLICY IF EXISTS "inspection_forms_select_own_or_org_owner"
  ON public.inspection_forms;
DROP POLICY IF EXISTS "inspection_forms_select_own_or_org_visible"
  ON public.inspection_forms;

CREATE POLICY "inspection_forms_select_own_or_org_visible"
  ON public.inspection_forms FOR SELECT
  USING (
    (auth.uid() = user_id) OR public.auth_uid_can_view_org_of(user_id)
  );

-- ── 3. Revoke client grants on the service-role-only tables ───────────────────
-- Guarded: only revokes on tables that actually exist in the live DB.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_billing',
    'route_cache',
    'trial_devices',
    'inspection_reports',
    'form_editor_tokens',
    'form_templates'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
