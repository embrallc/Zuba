-- ─────────────────────────────────────────────────────────────────────────────
-- Account deletion infrastructure.
--
-- The destructive paths run from the `delete-account` Edge Function, which
-- uses the service role. These SECURITY DEFINER helpers exist so the cascade
-- happens atomically in one SQL statement set rather than many round-trips.
--
-- Note: users.org_sk is UUID (migration 20260518020000), not TEXT.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── HELPER: is caller an owner of the given org_sk? ──────────────────────────
CREATE OR REPLACE FUNCTION public.auth_uid_owns_org(p_org_sk UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users me
    WHERE me.id            = auth.uid()
      AND me.user_profile  = 'owner'
      AND me.org_sk        IS NOT NULL
      AND me.org_sk        = p_org_sk
  );
$$;


-- ── FULL-ORG CASCADE DELETE ──────────────────────────────────────────────────
-- Wipes every auth.users row in the org. ON DELETE CASCADE FKs handle
-- inspections, descriptions, details, templates, sms, api_cache, and
-- public.users itself. The organizations row is removed last (auth.users
-- does not cascade to it).
CREATE OR REPLACE FUNCTION public.delete_org_cascade(p_org_sk UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_org_sk IS NULL THEN
    RAISE EXCEPTION 'org_sk is required';
  END IF;

  DELETE FROM auth.users a
  WHERE a.id IN (SELECT u.id FROM public.users u WHERE u.org_sk = p_org_sk);

  DELETE FROM public.organizations WHERE org_sk = p_org_sk;
END;
$$;


-- ── USER-ONLY DELETE WITH SUCCESSOR REASSIGNMENT ─────────────────────────────
-- Preserves org data by re-pointing p_user_id's rows at p_successor_id
-- before dropping the auth user. api_cache is per-user and not transferable.
CREATE OR REPLACE FUNCTION public.delete_user_reassign(
  p_user_id      UUID,
  p_successor_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_user_id IS NULL OR p_successor_id IS NULL THEN
    RAISE EXCEPTION 'user_id and successor_id are required';
  END IF;
  IF p_user_id = p_successor_id THEN
    RAISE EXCEPTION 'successor cannot be the same as the user being deleted';
  END IF;

  UPDATE public.inspections             SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.inspection_descriptions SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.inspection_details      SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.section_templates       SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.sms_templates           SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.sms_status              SET user_id = p_successor_id WHERE user_id = p_user_id;
  UPDATE public.organizations           SET user_id = p_successor_id WHERE user_id = p_user_id;

  DELETE FROM public.api_cache WHERE user_id = p_user_id;

  -- Drops the auth user; public.users row cascades via FK.
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;


-- ── STORAGE RLS — let org owner read by orgSk prefix ─────────────────────────
-- After a user_only delete, photos stay at paths {orgSk}/{deletedUserId}/...
-- The deleted user is no longer in public.users so the existing
-- "org owner of segment-2 userId" check returns false. Add an explicit
-- "caller owns the org named in segment-1" branch so the remaining owner(s)
-- can still read them. split_part returns TEXT; cast to UUID for the call.
DROP POLICY IF EXISTS "inspection_images_select" ON storage.objects;
CREATE POLICY "inspection_images_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'inspection-images'
    AND (
      auth.uid()::TEXT = split_part(name, '/', 2)
      OR (
        split_part(name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.auth_uid_is_org_owner_of((split_part(name, '/', 2))::UUID)
      )
      OR (
        split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.auth_uid_owns_org((split_part(name, '/', 1))::UUID)
      )
    )
  );
