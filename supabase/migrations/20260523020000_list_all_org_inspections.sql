-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: list_all_org_inspections
--
-- Returns every inspection in the caller's organization — assigned and
-- orphaned — for the All Inspections screen used by owners and admins to
-- reassign work (e.g. when a teammate is out sick).
--
-- The regular RLS path returns assigned inspections via
-- `auth_uid_can_view_org_of(user_id)` but skips orphans (user_id IS NULL).
-- This SECURITY DEFINER RPC keeps the regular RLS clean while giving the
-- screen one query that covers both cases.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_all_org_inspections()
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
    ORDER BY scheduled_at DESC NULLS LAST;
END;
$$;
