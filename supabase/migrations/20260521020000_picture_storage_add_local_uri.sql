-- ─────────────────────────────────────────────────────────────────────────────
-- Mirror the SQLite InspectionDetail schema: add local_picture_uri so the
-- cloud row carries both the device file path (originator) and the bucket key.
--
-- Local paths from the originating device are meaningless on other devices,
-- but the app's resolvePhotoUri checks file existence before using a local
-- path and falls back to a signed cloud URL — so cross-device pull of a
-- non-existent path is safe (just a cheap FS stat that misses, then signed
-- URL).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inspection_details
  ADD COLUMN IF NOT EXISTS local_picture_uri TEXT;
