-- ─────────────────────────────────────────────────────────────────────────────
-- Walkthrough forms — owner-built data-capture templates + per-inspection
-- answers, replacing the fixed relational inspection_descriptions /
-- inspection_details model with a flexible JSONB document model.
--
-- Phase 1 is ADDITIVE: the old tables are left in place so the current
-- inspection form keeps working until the dynamic renderer + sync rewire land
-- (later phases). They get dropped at cutover.
-- ─────────────────────────────────────────────────────────────────────────────

-- One walkthrough template per org. draft_schema is the builder's working
-- copy; published_schema is what NEW inspections snapshot. Owner edits flow
-- through the form-editor edge function (service role), same as form_templates
-- — so there is no INSERT/UPDATE policy here. The difference from
-- form_templates: members must READ the published template to render
-- walkthroughs on their own devices, so a member SELECT policy is added.
CREATE TABLE IF NOT EXISTS walkthrough_templates (
  org_sk             UUID PRIMARY KEY REFERENCES organizations(org_sk) ON DELETE CASCADE,
  name               TEXT NOT NULL DEFAULT 'Walkthrough',
  draft_schema       JSONB,
  published_schema   JSONB,
  published_version  INTEGER NOT NULL DEFAULT 0,
  draft_updated_at   TIMESTAMPTZ DEFAULT NOW(),
  published_at       TIMESTAMPTZ,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE walkthrough_templates ENABLE ROW LEVEL SECURITY;

-- Any member of the org may read their org's template (offline-first render).
-- auth_uid_org_sk() was added in 20260613010000.
DROP POLICY IF EXISTS "walkthrough_templates_select_org" ON walkthrough_templates;
CREATE POLICY "walkthrough_templates_select_org"
  ON walkthrough_templates FOR SELECT
  TO authenticated
  USING (org_sk::TEXT = public.auth_uid_org_sk());
-- No INSERT/UPDATE/DELETE policies: writes go through the edge function
-- (service role), owner-gated in code.

-- Per-inspection form, 1:1 with inspections. schema_snapshot freezes the
-- template the inspection was created under (stability + offline); answers is
-- the filled data keyed by field id. Replaces inspection_descriptions +
-- inspection_details. user_id denormalized for the same RLS model as those.
CREATE TABLE IF NOT EXISTS inspection_forms (
  inspection_sk     TEXT PRIMARY KEY REFERENCES inspections(inspection_sk) ON DELETE CASCADE,
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  template_version  INTEGER NOT NULL DEFAULT 0,
  schema_snapshot   JSONB,
  answers           JSONB NOT NULL DEFAULT '{}'::jsonb,
  _version          INTEGER DEFAULT 1,
  _last_changed_at  BIGINT,
  _deleted          BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspection_forms_user_id ON inspection_forms(user_id);

ALTER TABLE inspection_forms ENABLE ROW LEVEL SECURITY;

-- Same own-or-org-owner visibility as inspections; writes are own-only.
DROP POLICY IF EXISTS "inspection_forms_select_own_or_org_owner" ON inspection_forms;
CREATE POLICY "inspection_forms_select_own_or_org_owner"
  ON inspection_forms FOR SELECT
  USING (auth.uid() = user_id OR public.auth_uid_is_org_owner_of(user_id));

DROP POLICY IF EXISTS "inspection_forms_insert_own" ON inspection_forms;
CREATE POLICY "inspection_forms_insert_own"
  ON inspection_forms FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "inspection_forms_update_own" ON inspection_forms;
CREATE POLICY "inspection_forms_update_own"
  ON inspection_forms FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "inspection_forms_delete_own" ON inspection_forms;
CREATE POLICY "inspection_forms_delete_own"
  ON inspection_forms FOR DELETE USING (auth.uid() = user_id);
