-- ─────────────────────────────────────────────────────────────────────────────
-- Drop notification_settings.
--
-- Notification toggles are device-local — each phone schedules its own
-- reminders, so syncing the toggle state between devices added no value.
-- Local SQLite + AsyncStorage are the source of truth going forward.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS notification_settings;
