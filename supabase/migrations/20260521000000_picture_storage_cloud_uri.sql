-- ─────────────────────────────────────────────────────────────────────────────
-- Picture storage: split local vs cloud URI.
--
-- Local SQLite stores LocalPictureURI (device file path) and CloudPictureURI
-- (Storage bucket key). The cloud DB only needs the cloud URI — local paths
-- are device-specific and meaningless across devices.
--
-- Existing rows held device-local paths in picture_uri (pre-existing bug).
-- After rename, that data is effectively garbage and will be overwritten on
-- next upload to the "inspections-images" bucket.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inspection_details
  RENAME COLUMN picture_uri TO cloud_picture_uri;
