-- ─────────────────────────────────────────────────────────────────────────────
-- Bump _version + _last_changed_at on every row touched by the destructive
-- RPCs (reassign_inspection, delete_user_orphan) so the client sync layer
-- can detect the change.
--
-- The pull-side of sync.js compares `cloud._version > local._version` to
-- decide whether to refresh a row locally. Without a bump here, reassigning
-- an inspection silently changed user_id on the cloud but left every client
-- with stale local rows still attributed to the previous owner.
--
-- For section_templates / sms_templates (no _version column) we bump
-- updated_at, which is what those tables' pull comparison uses.
-- ─────────────────────────────────────────────────────────────────────────────


CREATE OR REPLACE FUNCTION public.reassign_inspection(
  p_inspection_sk TEXT,
  p_new_user_id   UUID
)
RETURNS TABLE(detail_sk TEXT, old_cloud_uri TEXT)
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

  UPDATE public.inspection_descriptions
     SET user_id          = p_new_user_id,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE inspection_sk = p_inspection_sk;

  UPDATE public.inspection_details d
     SET user_id          = p_new_user_id,
         _version         = COALESCE(d._version, 1) + 1,
         _last_changed_at = v_now
    FROM public.inspection_descriptions de
   WHERE d.inspection_description_sk = de.inspection_description_sk
     AND de.inspection_sk = p_inspection_sk;

  UPDATE public.sms_status
     SET user_id          = p_new_user_id,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE inspection_sk = p_inspection_sk;

  RETURN QUERY
    SELECT d.inspection_detail_sk, d.cloud_picture_uri
    FROM   public.inspection_details d
    JOIN   public.inspection_descriptions de
      ON   d.inspection_description_sk = de.inspection_description_sk
    WHERE  de.inspection_sk = p_inspection_sk
      AND  d.cloud_picture_uri IS NOT NULL;
END;
$$;


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

  UPDATE public.inspections
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now,
         updated_at       = NOW()
   WHERE user_id = p_user_id;

  UPDATE public.inspection_descriptions
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE user_id = p_user_id;

  UPDATE public.inspection_details
     SET user_id          = NULL,
         _version         = COALESCE(_version, 1) + 1,
         _last_changed_at = v_now
   WHERE user_id = p_user_id;

  UPDATE public.section_templates
     SET user_id    = NULL,
         updated_at = NOW()
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
  DELETE FROM auth.users      WHERE id = p_user_id;
END;
$$;
