-- SECURITY FIX (review 2026-07-16): lock down the anon/authenticated surface
-- opened by the blanket grants in 20260624000000_grant_api_roles.sql.
--
-- That migration did, to make fresh environments match legacy prod:
--   GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, ...
--   ALTER DEFAULT PRIVILEGES ... GRANT ALL ON ROUTINES TO anon, authenticated
-- which handed EXECUTE on EVERY function (existing + future) to the public API
-- roles — including SECURITY DEFINER functions that BYPASS RLS. Several of those
-- are destructive and were written assuming ONLY the service role (Edge
-- Functions) would ever call them, so they carry NO internal authorization
-- check. Net effect: anyone holding the publishable/anon key (it ships in the
-- app bundle, and soon on the marketing site) could call them via
-- POST /rest/v1/rpc/<fn> and, e.g., delete an entire organization.
--
-- This also silently reverted the targeted `revoke ... from anon` on
-- sweep_unsent_reports (20260620), because 20260624 re-granted it afterward.
--
-- Fixes (all idempotent + env-safe via to_regprocedure/to_regclass guards):
--   1. Service-role-only destructive RPCs → revoke from public, anon,
--      authenticated. Callers are Edge Functions using the service_role key,
--      which keeps its own explicit grant, so nothing legitimate breaks.
--   2. Authenticated-only RPCs → revoke from public, anon; keep authenticated
--      (they are internally org/role-scoped; the app calls them signed-in).
--   3. Observability views → revoke leftover anon/authenticated grants
--      (already safe via security_invoker; matches v_feedback_recent hardening).
--   4. TRUNCATE → revoke from anon/authenticated on every table (never
--      reachable through PostgREST, but should never have been granted).
--   5. Stop auto-granting EXECUTE on FUTURE routines to anon.

-- ── 1 + 2. Function EXECUTE lockdown ─────────────────────────────────────────
do $$
declare fn text;
begin
  -- Service-role-only + UNGUARDED destructive RPCs: no public API role executes.
  foreach fn in array array[
    'public.delete_org_cascade(uuid)',
    'public.delete_user_orphan(uuid)',
    'public.delete_user_reassign(uuid, uuid)',
    'public.reassign_inspection(text, uuid)',
    'public.sweep_unsent_reports()'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end if;
  end loop;

  -- Authenticated-only, internally org/role-scoped RPCs: drop anon/public only.
  foreach fn in array array[
    'public.list_all_org_inspections()',
    'public.list_unassigned_inspections()',
    'public.set_billing_owner(uuid)'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon', fn);
    end if;
  end loop;
end $$;

-- ── 3. Observability views: strip the leftover public-role grants ────────────
do $$
begin
  if to_regclass('public.v_app_errors_recent') is not null then
    revoke all on public.v_app_errors_recent from anon, authenticated;
  end if;
  if to_regclass('public.v_process_health_daily') is not null then
    revoke all on public.v_process_health_daily from anon, authenticated;
  end if;
end $$;

-- ── 4. TRUNCATE is never issued via the API — pull it from every table ───────
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;

-- ── 5. Root cause: stop auto-exposing FUTURE objects to the public API roles ─
-- These ALTERs only affect objects created LATER by the migration role; every
-- existing object is handled by the explicit revokes above. From here on:
--
--   * A new public FUNCTION is NOT auto-executable by anon OR authenticated.
--     Any function the app/site calls must grant EXECUTE explicitly, e.g.
--       grant execute on function public.my_fn(...) to authenticated;
--     A missing grant fails closed (permission denied) — caught in testing, not
--     a silent security hole. This is the whole point: a future SECURITY DEFINER
--     function can never again auto-expose itself to the world.
--
--   * A new public TABLE is NOT auto-granted to anon (authenticated keeps its
--     default so the app's local-first sync keeps working without per-table
--     grants — RLS remains its boundary). A future anon-facing table (like a
--     public form) must grant + policy anon explicitly, as waitlist does.
alter default privileges in schema public revoke execute on routines from anon, authenticated;
alter default privileges in schema public revoke all     on tables   from anon;
