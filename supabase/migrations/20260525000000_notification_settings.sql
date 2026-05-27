-- ─────────────────────────────────────────────────────────────────────────────
-- Notification settings: one row per (user, notification_name).
-- Local mirror lives in NotificationSettings (SQLite). User-scoped only —
-- no org/admin visibility, every user controls their own toggles.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_settings (
  notification_sk     UUID PRIMARY KEY NOT NULL,
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  notification_name   TEXT NOT NULL,
  is_notification_on  BOOLEAN NOT NULL DEFAULT FALSE,
  _version            INTEGER DEFAULT 1,
  _last_changed_at    BIGINT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, notification_name)
);

CREATE INDEX IF NOT EXISTS idx_notification_settings_user_id
  ON notification_settings(user_id);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notif_settings_select_own"
  ON notification_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "notif_settings_insert_own"
  ON notification_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notif_settings_update_own"
  ON notification_settings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "notif_settings_delete_own"
  ON notification_settings FOR DELETE USING (auth.uid() = user_id);
