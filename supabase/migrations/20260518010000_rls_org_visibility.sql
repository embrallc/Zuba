-- ─────────────────────────────────────────────────────────────────────────────
-- Org-scoped SELECT visibility
--
-- owners  → can read all rows belonging to any user in their org
-- members → can only read their own rows (unchanged)
--
-- INSERT / UPDATE / DELETE are NOT changed — every user still writes only
-- their own rows regardless of profile.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── HELPER FUNCTION ───────────────────────────────────────────────────────────
-- Returns true when the calling user is an 'owner' whose org_sk matches the
-- org_sk of the target user.  SECURITY DEFINER lets it read the users table
-- without being blocked by the users RLS policy itself.

CREATE OR REPLACE FUNCTION auth_uid_is_org_owner_of(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   users me
    JOIN   users target ON target.id = target_user_id
    WHERE  me.id            = auth.uid()
      AND  me.user_profile  = 'owner'
      AND  me.org_sk        IS NOT NULL
      AND  me.org_sk        = target.org_sk
  );
$$;


-- ── users ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users_select_own" ON users;
CREATE POLICY "users_select_own_or_org_owner"
  ON users FOR SELECT
  USING (auth.uid() = id OR auth_uid_is_org_owner_of(id));


-- ── inspections ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "inspections_select_own" ON inspections;
CREATE POLICY "inspections_select_own_or_org_owner"
  ON inspections FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── inspection_descriptions ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "desc_select_own" ON inspection_descriptions;
CREATE POLICY "desc_select_own_or_org_owner"
  ON inspection_descriptions FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── inspection_details ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "detail_select_own" ON inspection_details;
CREATE POLICY "detail_select_own_or_org_owner"
  ON inspection_details FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── section_templates ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "tmpl_select_own" ON section_templates;
CREATE POLICY "tmpl_select_own_or_org_owner"
  ON section_templates FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── sms_templates ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "sms_tmpl_select_own" ON sms_templates;
CREATE POLICY "sms_tmpl_select_own_or_org_owner"
  ON sms_templates FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── sms_status ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "sms_status_select_own" ON sms_status;
CREATE POLICY "sms_status_select_own_or_org_owner"
  ON sms_status FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));


-- ── api_cache ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "cache_select_own" ON api_cache;
CREATE POLICY "cache_select_own_or_org_owner"
  ON api_cache FOR SELECT
  USING (auth.uid() = user_id OR auth_uid_is_org_owner_of(user_id));
