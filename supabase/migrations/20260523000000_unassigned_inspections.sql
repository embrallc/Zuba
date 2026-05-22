-- ─────────────────────────────────────────────────────────────────────────────
-- Unassigned-records infrastructure.
--
-- After a user-only account deletion the user's records are left with
-- user_id = NULL. We need a way to:
--   (a) find those orphans by org_sk, and
--   (b) reassign all related rows (inspection_descriptions, inspection_details,
--       sms_status) plus the storage objects backing each photo.
--
-- Approach:
--   1. Denormalize org_sk onto inspections so orphan rows still know their
--      home org. A BEFORE INSERT trigger derives it from the inserting user.
--   2. Expose a SECURITY DEFINER RPC `list_unassigned_inspections` that
--      returns orphans for the caller's org without changing the regular
--      RLS policies (so the routine sync pulls don't accidentally drag
--      orphans into local DBs).
--   3. Expose `reassign_inspection(inspection_sk, new_user_id)` that walks
--      the FK chain to re-point every dependent row and returns the detail
--      rows holding cloud photos so the Edge Function can move storage.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── inspections.org_sk ───────────────────────────────────────────────────────
ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS org_sk UUID
    REFERENCES public.organizations(org_sk) ON DELETE SET NULL;

UPDATE public.inspections i
SET    org_sk = u.org_sk
FROM   public.users u
WHERE  i.user_id = u.id
  AND  i.org_sk IS NULL;

CREATE INDEX IF NOT EXISTS idx_inspections_org_sk_user_id
  ON public.inspections(org_sk, user_id);


-- BEFORE INSERT trigger: populate org_sk if the client didn't supply it.
CREATE OR REPLACE FUNCTION public.inspections_set_org_sk()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.org_sk IS NULL THEN
    IF NEW.user_id IS NOT NULL THEN
      SELECT org_sk INTO NEW.org_sk
      FROM public.users WHERE id = NEW.user_id;
    ELSE
      SELECT org_sk INTO NEW.org_sk
      FROM public.users WHERE id = auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inspections_set_org_sk ON public.inspections;
CREATE TRIGGER inspections_set_org_sk
BEFORE INSERT ON public.inspections
FOR EACH ROW EXECUTE FUNCTION public.inspections_set_org_sk();


-- ── list_unassigned_inspections() ────────────────────────────────────────────
-- Returns orphaned inspections in the caller's org. Only owners and admins
-- get rows; everyone else gets an empty set.
CREATE OR REPLACE FUNCTION public.list_unassigned_inspections()
RETURNS SETOF public.inspections
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_org_sk UUID;
  v_role   TEXT;
BEGIN
  SELECT org_sk, user_profile INTO v_org_sk, v_role
  FROM public.users WHERE id = auth.uid();

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT * FROM public.inspections
    WHERE org_sk = v_org_sk
      AND user_id IS NULL
    ORDER BY scheduled_at DESC NULLS LAST;
END;
$$;


-- ── reassign_inspection(inspection_sk, new_user_id) ──────────────────────────
-- Cascades the new owner through every dependent row reachable via the FK
-- chain. Returns the inspection_details rows with cloud_picture_uri set so
-- the Edge Function can move the storage objects to the new owner's path.
CREATE OR REPLACE FUNCTION public.reassign_inspection(
  p_inspection_sk TEXT,
  p_new_user_id   UUID
)
RETURNS TABLE(detail_sk TEXT, old_cloud_uri TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_inspection_sk IS NULL OR p_new_user_id IS NULL THEN
    RAISE EXCEPTION 'inspection_sk and new_user_id are required';
  END IF;

  UPDATE public.inspections
     SET user_id = p_new_user_id
   WHERE inspection_sk = p_inspection_sk;

  UPDATE public.inspection_descriptions
     SET user_id = p_new_user_id
   WHERE inspection_sk = p_inspection_sk;

  UPDATE public.inspection_details d
     SET user_id = p_new_user_id
    FROM public.inspection_descriptions de
   WHERE d.inspection_description_sk = de.inspection_description_sk
     AND de.inspection_sk = p_inspection_sk;

  UPDATE public.sms_status
     SET user_id = p_new_user_id
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
