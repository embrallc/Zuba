-- ─────────────────────────────────────────────────────────────────────────────
-- Add SMS tables: sms_templates, sms_status
-- ─────────────────────────────────────────────────────────────────────────────


-- ── TABLES ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_templates (
  sms_template_sk TEXT PRIMARY KEY NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  position        INTEGER NOT NULL DEFAULT 0,
  _version        INTEGER DEFAULT 1,
  _last_changed_at BIGINT,
  _deleted        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_status (
  sms_status_sk   TEXT PRIMARY KEY NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  inspection_sk   TEXT REFERENCES inspections(inspection_sk) ON DELETE CASCADE NOT NULL,
  sms_template_sk TEXT REFERENCES sms_templates(sms_template_sk) ON DELETE CASCADE NOT NULL,
  sent            BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         BIGINT,
  _version        INTEGER DEFAULT 1,
  _last_changed_at BIGINT,
  _deleted        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(inspection_sk, sms_template_sk)
);


-- ── INDEXES ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sms_templates_user_id ON sms_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_status_user_id    ON sms_status(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_status_inspection ON sms_status(inspection_sk);


-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

ALTER TABLE sms_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_status    ENABLE ROW LEVEL SECURITY;

-- sms_templates
CREATE POLICY "sms_tmpl_select_own" ON sms_templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sms_tmpl_insert_own" ON sms_templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sms_tmpl_update_own" ON sms_templates FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sms_tmpl_delete_own" ON sms_templates FOR DELETE USING (auth.uid() = user_id);

-- sms_status
CREATE POLICY "sms_status_select_own" ON sms_status FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sms_status_insert_own" ON sms_status FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sms_status_update_own" ON sms_status FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sms_status_delete_own" ON sms_status FOR DELETE USING (auth.uid() = user_id);
