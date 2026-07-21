-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: public.delete_user_orphan referenced public.api_cache, a legacy table
-- (Google Routes / Weather / Gemini cache, superseded by route_cache) that was
-- DROPPED from the live DB outside migrations. PL/pgSQL is late-binding, so the
-- function was created fine but every CALL failed with:
--     relation "public.api_cache" does not exist
--
-- Impact — this broke TWO prod paths that both call delete_user_orphan():
--   • delete-user   EF → owner "Deny / remove teammate" (Approvals inbox)
--   • delete-account EF → non-sole-owner self-deletion (userOnlyDelete)
-- Surfaced during prod TestFlight billing testing: "Couldn't Remove —
-- relation public.api_cache does not exist".
--
-- The explicit DELETE was always REDUNDANT: api_cache.user_id was declared
-- REFERENCES auth.users(id) ON DELETE CASCADE, so the DELETE FROM auth.users at
-- the end already removed any api_cache rows. Dropping the line is therefore
-- safe whether or not api_cache exists in a given environment (if it exists, the
-- cascade still cleans it; if it's gone, there's nothing to clean).
--
-- This is a faithful copy of the post-cutover definition in
-- 20260614000000_drop_legacy_inspection_tables.sql, minus the api_cache line.
--
-- Also drops the dead public.delete_user_reassign(uuid, uuid): it is called
-- NOWHERE (superseded by the orphan approach) and still references both
-- api_cache and the legacy tables dropped in 20260614 — a latent
-- SECURITY DEFINER landmine we remove rather than carry.
-- ─────────────────────────────────────────────────────────────────────────────


CREATE OR REPLACE FUNCTION public.delete_user_orphan(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  v_now := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

  -- NULL out user_id so the records survive the CASCADE that fires when
  -- auth.users is deleted below.
  UPDATE public.inspections
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now,
         updated_at       = NOW()
   WHERE user_id = p_user_id;

  UPDATE public.inspection_forms
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE user_id = p_user_id;

  UPDATE public.sms_templates
     SET user_id    = NULL,
         updated_at = NOW()
   WHERE user_id = p_user_id;

  UPDATE public.sms_status
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE user_id = p_user_id;

  -- (Removed: DELETE FROM public.api_cache — table dropped; the auth.users
  -- CASCADE below already covered its per-user rows when it existed.)
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

-- Re-assert the service-role-only lockdown (matches 20260716000100). CREATE OR
-- REPLACE preserves the existing ACL, but we re-state it so this migration is
-- self-documenting and safe if applied out of order. service_role keeps its own
-- explicit grant; the app never calls this directly.
REVOKE EXECUTE ON FUNCTION public.delete_user_orphan(UUID) FROM public, anon, authenticated;

-- Remove the dead, broken, unused reassign function.
DROP FUNCTION IF EXISTS public.delete_user_reassign(UUID, UUID);
