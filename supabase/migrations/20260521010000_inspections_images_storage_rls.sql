-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the "inspections-images" Storage bucket.
--
-- Path convention: {org_sk}/{user_id}/{detail_sk}/{timestamp}.jpg
--   split_part(name, '/', 1) = org_sk
--   split_part(name, '/', 2) = user_id
--
-- Owner of the photo can do all CRUD on it. Org owners can additionally read
-- photos uploaded by their org members (mirrors the table-level policies set
-- up in 20260518010000_rls_org_visibility.sql).
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "inspections_images_select" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_insert" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_update" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_delete" ON storage.objects;

CREATE POLICY "inspections_images_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'inspections-images'
    AND (
      auth.uid()::TEXT = split_part(name, '/', 2)
      OR (
        split_part(name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.auth_uid_is_org_owner_of((split_part(name, '/', 2))::UUID)
      )
    )
  );

CREATE POLICY "inspections_images_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'inspections-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );

CREATE POLICY "inspections_images_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'inspections-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );

CREATE POLICY "inspections_images_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inspections-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );
