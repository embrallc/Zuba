-- ─────────────────────────────────────────────────────────────────────────────
-- Form Builder: per-org report templates + tokenized browser-editor access
-- Apply via: npx supabase db push
-- ─────────────────────────────────────────────────────────────────────────────

-- One template per org (v1). draft_schema is what the editor works on;
-- published_schema is what report generation reads. Publishing copies
-- draft → published so an owner can iterate without breaking live reports.
CREATE TABLE IF NOT EXISTS form_templates (
  org_sk            UUID PRIMARY KEY REFERENCES organizations(org_sk) ON DELETE CASCADE,
  name              TEXT NOT NULL DEFAULT 'Inspection Report',
  draft_schema      JSONB,
  published_schema  JSONB,
  draft_updated_at  TIMESTAMPTZ DEFAULT NOW(),
  published_at      TIMESTAMPTZ,
  updated_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Long-lived editor links. The raw token only ever exists in the URL we hand
-- the owner; we store a SHA-256 hash. Minting a new link revokes prior ones,
-- so "Regenerate" is the kill switch if a link ever leaks.
CREATE TABLE IF NOT EXISTS form_editor_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_sk      UUID NOT NULL REFERENCES organizations(org_sk) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_form_editor_tokens_org ON form_editor_tokens(org_sk);

-- Service-role only: RLS enabled with no policies. All access goes through
-- the form-editor edge function, which authenticates via token (browser) or
-- Supabase JWT + owner check (app).
ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_editor_tokens ENABLE ROW LEVEL SECURITY;
