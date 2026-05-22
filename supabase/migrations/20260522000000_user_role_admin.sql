-- ─────────────────────────────────────────────────────────────────────────────
-- Add 'admin' role + admin org visibility.
--
-- Roles:
--   owner  → can view org data AND change other users' roles
--   admin  → can view org data only (no role management)
--   member → can only view their own data
--
-- A new helper `auth_uid_can_view_org_of(uuid)` returns TRUE when the caller
-- is owner or admin in the same org as the target user. SELECT policies on
-- all sync-eligible tables switch from `auth_uid_is_org_owner_of` to this
-- broader helper. `auth_uid_is_org_owner_of` stays as-is for the stricter
-- "owner-only" gates used in role-management migrations.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── CHECK CONSTRAINT ─────────────────────────────────────────────────────────
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_user_profile_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_user_profile_check
  CHECK (user_profile IN ('owner', 'admin', 'member'));


-- ── HELPER ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_uid_can_view_org_of(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.users me
    JOIN   public.users target ON target.id = target_user_id
    WHERE  me.id            = auth.uid()
      AND  me.user_profile  IN ('owner', 'admin')
      AND  me.org_sk        IS NOT NULL
      AND  me.org_sk        = target.org_sk
  );
$$;


-- ── SELECT POLICIES (broaden from owner-only to owner-or-admin) ──────────────
DROP POLICY IF EXISTS "users_select_own_or_org_owner" ON public.users;
CREATE POLICY "users_select_own_or_org_visible"
  ON public.users FOR SELECT
  USING (auth.uid() = id OR public.auth_uid_can_view_org_of(id));

DROP POLICY IF EXISTS "inspections_select_own_or_org_owner" ON public.inspections;
CREATE POLICY "inspections_select_own_or_org_visible"
  ON public.inspections FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "desc_select_own_or_org_owner" ON public.inspection_descriptions;
CREATE POLICY "desc_select_own_or_org_visible"
  ON public.inspection_descriptions FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "detail_select_own_or_org_owner" ON public.inspection_details;
CREATE POLICY "detail_select_own_or_org_visible"
  ON public.inspection_details FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "tmpl_select_own_or_org_owner" ON public.section_templates;
CREATE POLICY "tmpl_select_own_or_org_visible"
  ON public.section_templates FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "sms_tmpl_select_own_or_org_owner" ON public.sms_templates;
CREATE POLICY "sms_tmpl_select_own_or_org_visible"
  ON public.sms_templates FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "sms_status_select_own_or_org_owner" ON public.sms_status;
CREATE POLICY "sms_status_select_own_or_org_visible"
  ON public.sms_status FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));

DROP POLICY IF EXISTS "cache_select_own_or_org_owner" ON public.api_cache;
CREATE POLICY "cache_select_own_or_org_visible"
  ON public.api_cache FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_can_view_org_of(user_id));
