-- ─────────────────────────────────────────────────────────────────────────────
-- Add inspection status, user profile, and organizations table
-- Apply via: supabase db push
-- ─────────────────────────────────────────────────────────────────────────────


-- ── COLUMN ADDITIONS ─────────────────────────────────────────────────────────

-- inspections: workflow status
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS status TEXT
    CHECK(status IN ('OPEN', 'WORK', 'SENT', 'CLOSED'))
    DEFAULT 'OPEN';

-- users: role within their organization
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_profile TEXT
    CHECK(user_profile IN ('owner', 'member'));


-- ── ORGANIZATIONS TABLE ───────────────────────────────────────────────────────

-- org_sk is generated client-side (expo-crypto randomUUID) or server-side.
-- user_id is the owner — the first member who created the org at signup.
-- Members link to an org via users.org_sk; this table holds the canonical record.
CREATE TABLE IF NOT EXISTS organizations (
  org_sk     TEXT PRIMARY KEY NOT NULL,
  org_name   TEXT,
  user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── INDEXES ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_organizations_user_id ON organizations(user_id);


-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can look up an org by org_sk.
-- Members need this during signup to verify a provided org_sk exists before
-- their own users row is created, so we can't restrict by users.org_sk here.
-- org_sk is a UUID so discovery by enumeration is not a practical concern.
CREATE POLICY "org_select_authenticated"
  ON organizations FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only the owner (user_id) can insert, update, or delete their org.
CREATE POLICY "org_insert_own"
  ON organizations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "org_update_own"
  ON organizations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "org_delete_own"
  ON organizations FOR DELETE
  USING (auth.uid() = user_id);
