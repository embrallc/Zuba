-- ─────────────────────────────────────────────────────────────────────────────
-- Fix bucket name in storage RLS policies.
--
-- 20260521010000_inspections_images_storage_rls.sql referenced a bucket named
-- "inspections-images" (plural) but the actual bucket is "inspection-images"
-- (singular). Uploads returned 404 "Bucket not found". Drop the old policies
-- and recreate them against the correct bucket_id.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "inspections_images_select" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_insert" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_update" ON storage.objects;
DROP POLICY IF EXISTS "inspections_images_delete" ON storage.objects;

CREATE POLICY "inspection_images_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'inspection-images'
    AND (
      auth.uid()::TEXT = split_part(name, '/', 2)
      OR (
        split_part(name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.auth_uid_is_org_owner_of((split_part(name, '/', 2))::UUID)
      )
    )
  );

CREATE POLICY "inspection_images_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'inspection-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );

CREATE POLICY "inspection_images_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'inspection-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );

CREATE POLICY "inspection_images_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inspection-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
  );
