-- Private bucket for Form Builder image assets (company logos, badges, etc.).
-- Uploaded from the browser editor through the token-authed form-editor edge
-- function; read back the same way (302 → signed URL) and by the report
-- generator (service role). No storage RLS policies on purpose — service-role
-- only, like inspection-reports.
INSERT INTO storage.buckets (id, name, public)
VALUES ('form-assets', 'form-assets', false)
ON CONFLICT (id) DO NOTHING;
