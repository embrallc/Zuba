-- Tighten inspection-images write policies (security sweep 2026-06-12 #6).
--
-- The INSERT/UPDATE policies validated only the USER segment (segment 2) of
-- the object path `{org_sk}/{user_id}/{detail_sk}/{ts}.jpg`, so any
-- authenticated user could write objects under ANOTHER org's prefix. That
-- junk would pollute org-prefix sweeps (delete-account) and storage costs.
-- Pin segment 1 to the caller's own org.
--
-- SELECT/DELETE are unchanged: both already require the caller to own the
-- user segment (or be its org owner), which is sufficient for reads/removal.

CREATE OR REPLACE FUNCTION public.auth_uid_org_sk()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT org_sk::TEXT FROM public.users WHERE id = auth.uid();
$$;

DROP POLICY IF EXISTS "inspection_images_insert" ON storage.objects;
CREATE POLICY "inspection_images_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'inspection-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
    AND split_part(name, '/', 1) = public.auth_uid_org_sk()
  );

DROP POLICY IF EXISTS "inspection_images_update" ON storage.objects;
CREATE POLICY "inspection_images_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'inspection-images'
    AND auth.uid()::TEXT = split_part(name, '/', 2)
    AND split_part(name, '/', 1) = public.auth_uid_org_sk()
  );
