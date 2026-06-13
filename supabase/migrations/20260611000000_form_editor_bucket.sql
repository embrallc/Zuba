-- Public bucket hosting the Form Builder single-file web app. The HTML is
-- inert without a valid ?t= token (it boots to a local sandbox), so public
-- read is safe — all org data flows through the token-gated form-editor
-- edge function API.
INSERT INTO storage.buckets (id, name, public)
VALUES ('form-editor-app', 'form-editor-app', true)
ON CONFLICT (id) DO NOTHING;
