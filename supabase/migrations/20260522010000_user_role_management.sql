-- ─────────────────────────────────────────────────────────────────────────────
-- Owner-managed role changes.
--
-- Server-side rules (the source of truth):
--   1. An org owner can UPDATE any user row in their org (RLS policy below).
--   2. Only an owner may change `user_profile` — enforced by trigger so that
--      a member can update their own fname/lname etc. but cannot self-promote.
--   3. The last remaining owner in an org cannot demote themselves — they
--      must promote someone else first.
--   4. When user_profile changes, mirror the new value into the target user's
--      `auth.users.raw_user_meta_data.user_profile` so their next session
--      refresh reflects the new role.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── OWNER CROSS-ROW UPDATE POLICY ────────────────────────────────────────────
DROP POLICY IF EXISTS "users_update_org_owner" ON public.users;
CREATE POLICY "users_update_org_owner"
  ON public.users FOR UPDATE
  USING (public.auth_uid_is_org_owner_of(id));


-- ── ROLE-CHANGE GUARD TRIGGER ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_user_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_role      TEXT;
  v_remaining_owners INT;
BEGIN
  -- Fast path: no role change → no checks needed.
  IF NEW.user_profile IS NOT DISTINCT FROM OLD.user_profile THEN
    RETURN NEW;
  END IF;

  -- Caller must be an owner in the same org as the target row.
  SELECT user_profile INTO v_caller_role
  FROM public.users
  WHERE id = auth.uid()
    AND org_sk = OLD.org_sk;

  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the organization owner can change user roles';
  END IF;

  -- Last-owner protection.
  IF OLD.user_profile = 'owner' AND NEW.user_profile <> 'owner' THEN
    SELECT COUNT(*) INTO v_remaining_owners
    FROM public.users
    WHERE org_sk = OLD.org_sk
      AND user_profile = 'owner'
      AND id <> OLD.id;
    IF v_remaining_owners = 0 THEN
      RAISE EXCEPTION
        'Cannot demote the last owner; promote another user to owner first';
    END IF;
  END IF;

  -- Mirror to auth metadata so the target user's next session sees the new role.
  UPDATE auth.users
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object('user_profile', NEW.user_profile)
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_user_role_change ON public.users;
CREATE TRIGGER enforce_user_role_change
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_role_change();
