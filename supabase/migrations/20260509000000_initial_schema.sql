-- ─────────────────────────────────────────────────────────────────────────────
-- Initial Schema — ClientManagement
-- Apply via: supabase db push
-- ─────────────────────────────────────────────────────────────────────────────


-- ── TABLES ───────────────────────────────────────────────────────────────────

-- Users — linked to Supabase Auth. user_sk mirrors the local SQLite UUID.
CREATE TABLE IF NOT EXISTS users (
  id            UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  user_sk       TEXT UNIQUE NOT NULL,
  fname         TEXT,
  lname         TEXT,
  org_sk        TEXT,
  role          TEXT CHECK(role IN ('admin', 'user')) DEFAULT 'user',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Inspections — cloud copy so Edge Functions can read addresses for routing.
CREATE TABLE IF NOT EXISTS inspections (
  inspection_sk    TEXT PRIMARY KEY NOT NULL,
  user_id          UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  full_name        TEXT,
  summary          TEXT,
  address_line1    TEXT,
  address_line2    TEXT,
  city             TEXT,
  state            TEXT,
  zip_code         TEXT,
  scheduled_at     TIMESTAMPTZ,
  phone            TEXT,
  email            TEXT,
  longitude        DOUBLE PRECISION,
  latitude         DOUBLE PRECISION,
  _version         INTEGER DEFAULT 1,
  _last_changed_at BIGINT,
  _deleted         BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Inspection Descriptions (sections) — user_id denormalized for simple RLS.
CREATE TABLE IF NOT EXISTS inspection_descriptions (
  inspection_description_sk TEXT PRIMARY KEY NOT NULL,
  inspection_sk             TEXT REFERENCES inspections(inspection_sk) ON DELETE CASCADE NOT NULL,
  user_id                   UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  description               TEXT,
  notes                     TEXT,
  position                  INTEGER DEFAULT 0,
  severity_level            TEXT DEFAULT NULL,
  _version                  INTEGER DEFAULT 1,
  _last_changed_at          BIGINT,
  _deleted                  BOOLEAN DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Inspection Details (photos) — user_id denormalized for simple RLS.
CREATE TABLE IF NOT EXISTS inspection_details (
  inspection_detail_sk      TEXT PRIMARY KEY NOT NULL,
  inspection_description_sk TEXT REFERENCES inspection_descriptions(inspection_description_sk) ON DELETE CASCADE NOT NULL,
  user_id                   UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  picture_uri               TEXT,
  picture_note              TEXT,
  picture_markup            TEXT,
  _version                  INTEGER DEFAULT 1,
  _last_changed_at          BIGINT,
  _deleted                  BOOLEAN DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Section Templates — user's reusable form section names.
CREATE TABLE IF NOT EXISTS section_templates (
  section_template_sk TEXT PRIMARY KEY NOT NULL,
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name                TEXT NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- API Cache — server-side cache for Google Routes, Weather, and Gemini summaries.
-- Cache keys: "routes:YYYY-MM-DD" | "weather:YYYY-MM-DD" | "summary:YYYY-MM-DD"
CREATE TABLE IF NOT EXISTS api_cache (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  cache_key   TEXT NOT NULL,
  value       JSONB NOT NULL,
  api_source  TEXT CHECK(api_source IN ('google_routes', 'weather', 'gemini')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, cache_key)
);


-- ── INDEXES ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_inspections_user_id       ON inspections(user_id);
CREATE INDEX IF NOT EXISTS idx_inspections_scheduled_at  ON inspections(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_insp_desc_inspection_sk   ON inspection_descriptions(inspection_sk);
CREATE INDEX IF NOT EXISTS idx_insp_desc_user_id         ON inspection_descriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_insp_detail_desc_sk       ON inspection_details(inspection_description_sk);
CREATE INDEX IF NOT EXISTS idx_insp_detail_user_id       ON inspection_details(user_id);
CREATE INDEX IF NOT EXISTS idx_section_tmpl_user_id      ON section_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_api_cache_user_key        ON api_cache(user_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires         ON api_cache(expires_at);


-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_details      ENABLE ROW LEVEL SECURITY;
ALTER TABLE section_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_cache               ENABLE ROW LEVEL SECURITY;

-- users
CREATE POLICY "users_select_own"  ON users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users_insert_own"  ON users FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "users_update_own"  ON users FOR UPDATE USING (auth.uid() = id);

-- inspections
CREATE POLICY "inspections_select_own" ON inspections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "inspections_insert_own" ON inspections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "inspections_update_own" ON inspections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "inspections_delete_own" ON inspections FOR DELETE USING (auth.uid() = user_id);

-- inspection_descriptions
CREATE POLICY "desc_select_own" ON inspection_descriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "desc_insert_own" ON inspection_descriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "desc_update_own" ON inspection_descriptions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "desc_delete_own" ON inspection_descriptions FOR DELETE USING (auth.uid() = user_id);

-- inspection_details
CREATE POLICY "detail_select_own" ON inspection_details FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "detail_insert_own" ON inspection_details FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "detail_update_own" ON inspection_details FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "detail_delete_own" ON inspection_details FOR DELETE USING (auth.uid() = user_id);

-- section_templates
CREATE POLICY "tmpl_select_own" ON section_templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "tmpl_insert_own" ON section_templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tmpl_update_own" ON section_templates FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "tmpl_delete_own" ON section_templates FOR DELETE USING (auth.uid() = user_id);

-- api_cache
CREATE POLICY "cache_select_own" ON api_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "cache_insert_own" ON api_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cache_update_own" ON api_cache FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "cache_delete_own" ON api_cache FOR DELETE USING (auth.uid() = user_id);
