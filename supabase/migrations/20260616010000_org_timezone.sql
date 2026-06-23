-- Per-org business time zone, owner-settable.
--
-- Stores an IANA zone (e.g. 'America/Chicago') on the org. The day-before SMS
-- appointment-reminder job reads it server-side to decide each org's "tomorrow"
-- and the local send hour; when null it falls back to a server default. It's an
-- org-wide setting (not per-device) so every seat's inspections are evaluated in
-- one consistent zone.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- The original org_update_own policy keys on organizations.user_id, which the
-- signup trigger no longer populates (it was dropped from the org INSERT back in
-- 20260518050000), so owners have NO working write path to their org row.
-- Replace it with an owner-scoped policy using the existing auth_uid_owns_org()
-- helper (SECURITY DEFINER owner check from 20260522020000).
DROP POLICY IF EXISTS "org_update_own" ON public.organizations;

CREATE POLICY "org_update_owner"
  ON public.organizations FOR UPDATE
  USING (public.auth_uid_owns_org(org_sk))
  WITH CHECK (public.auth_uid_owns_org(org_sk));
