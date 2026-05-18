-- ─────────────────────────────────────────────────────────────────────────────
-- Switch organizations.org_sk to a server-generated UUID.
-- Also tighten users.org_sk to UUID type and add the FK.
-- organizations was created in 20260518000000 with no data, safe to recreate.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── organizations: drop & recreate with gen_random_uuid() default ─────────────

DROP TABLE IF EXISTS organizations;

CREATE TABLE organizations (
  org_sk     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_name   TEXT,
  user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_user_id ON organizations(user_id);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_select_authenticated"
  ON organizations FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "org_insert_own"
  ON organizations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "org_update_own"
  ON organizations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "org_delete_own"
  ON organizations FOR DELETE
  USING (auth.uid() = user_id);


-- ── users.org_sk: TEXT → UUID, add FK ────────────────────────────────────────

ALTER TABLE users
  ALTER COLUMN org_sk TYPE UUID USING org_sk::UUID;

ALTER TABLE users
  ADD CONSTRAINT users_org_sk_fk
  FOREIGN KEY (org_sk) REFERENCES organizations(org_sk) ON DELETE SET NULL;
