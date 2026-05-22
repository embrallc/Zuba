-- ─────────────────────────────────────────────────────────────────────────────
-- Switch user-only account deletion from "reassign to successor" to
-- "orphan the records (user_id = NULL)". A future admin UI will surface
-- the orphans so an owner can reassign them.
--
-- Schema change: drop NOT NULL on user_id for every org-scoped table so the
-- orphan UPDATE doesn't blow up. The FK is intentionally left as
-- ON DELETE CASCADE — the orphan function NULLs user_id FIRST so the
-- subsequent auth.users delete has nothing to cascade-wipe for those rows.
-- api_cache and public.users still cascade (per-user data, no point keeping).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Drop NOT NULL on user_id columns ─────────────────────────────────────────
ALTER TABLE public.inspections             ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.inspection_descriptions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.inspection_details      ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.section_templates       ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.sms_templates           ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.sms_status              ALTER COLUMN user_id DROP NOT NULL;


-- ── Replace delete_user_reassign with delete_user_orphan ─────────────────────
DROP FUNCTION IF EXISTS public.delete_user_reassign(UUID, UUID);

CREATE OR REPLACE FUNCTION public.delete_user_orphan(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  -- NULL out user_id so the records survive the CASCADE that fires when
  -- auth.users is deleted below.
  UPDATE public.inspections             SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.inspection_descriptions SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.inspection_details      SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.section_templates       SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.sms_templates           SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.sms_status              SET user_id = NULL WHERE user_id = p_user_id;

  -- organizations.user_id is already ON DELETE SET NULL — no manual UPDATE
  -- needed; it'll auto-null if this user was the org's creator.
  -- public.users + public.api_cache cascade via their FKs.
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;
