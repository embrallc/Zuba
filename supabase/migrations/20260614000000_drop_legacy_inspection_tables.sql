-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 6 cutover — drop the legacy relational form model now that the
-- walkthrough JSONB document model (walkthrough_templates + inspection_forms)
-- is the only writer.
--
-- Tables removed:
--   • inspection_details       → replaced by photo refs inside inspection_forms.answers
--   • inspection_descriptions  → replaced by inspection_forms.answers sections
--   • section_templates        → replaced by the owner-built walkthrough template
--
-- Two SECURITY DEFINER RPCs reference these tables and MUST be redefined in the
-- same migration or they'll fail at call time (plpgsql is late-binding, so the
-- DROP succeeds but the next reassign / account-deletion would error):
--   • reassign_inspection  — now reassigns inspection_forms (photos move in the
--                            edge function by walking answers JSON, so this no
--                            longer returns detail rows → RETURNS VOID)
--   • delete_user_orphan   — now orphans inspection_forms instead of the trio
--
-- inspection_forms.user_id was NOT NULL; the orphan path needs to NULL it (so
-- the row survives the auth.users CASCADE), so drop the constraint first — same
-- pattern 20260522030000 applied to the old tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── inspection_forms.user_id: allow NULL for the orphan-on-delete path ────────
ALTER TABLE public.inspection_forms ALTER COLUMN user_id DROP NOT NULL;


-- ── reassign_inspection: reassign the inspection + its form + sms_status ──────
-- Return type changes (TABLE → VOID), so the old function must be dropped first.
-- Photo storage objects are relocated by the edge function, which walks
-- inspection_forms.answers (photo refs live in the JSON now, not detail rows).
DROP FUNCTION IF EXISTS public.reassign_inspection(TEXT, UUID);

CREATE FUNCTION public.reassign_inspection(
  p_inspection_sk TEXT,
  p_new_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now BIGINT;
BEGIN
  IF p_inspection_sk IS NULL OR p_new_user_id IS NULL THEN
    RAISE EXCEPTION 'inspection_sk and new_user_id are required';
  END IF;

  v_now := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

  UPDATE public.inspections
     SET user_id          = p_new_user_id,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now,
         updated_at       = NOW()
   WHERE inspection_sk = p_inspection_sk;

  UPDATE public.inspection_forms
     SET user_id          = p_new_user_id,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE inspection_sk = p_inspection_sk;

  UPDATE public.sms_status
     SET user_id          = p_new_user_id,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE inspection_sk = p_inspection_sk;
END;
$$;


-- ── delete_user_orphan: orphan inspection_forms instead of the dropped trio ───
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

  DELETE FROM public.api_cache WHERE user_id = p_user_id;
  DELETE FROM auth.users       WHERE id = p_user_id;
END;
$$;


-- ── Drop the legacy tables (children first; CASCADE clears policies + FKs) ────
DROP TABLE IF EXISTS public.inspection_details      CASCADE;
DROP TABLE IF EXISTS public.inspection_descriptions CASCADE;
DROP TABLE IF EXISTS public.section_templates       CASCADE;
