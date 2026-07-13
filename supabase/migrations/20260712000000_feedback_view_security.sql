-- Harden v_feedback_recent to match the project's other views over RLS-protected
-- tables (v_audit_recent in 20260702000100, the observability views in
-- 20260701000000). As originally created (20260711000000_feedback.sql) the view
-- was security_definer (the Postgres default) and carried no anon/authenticated
-- revoke. Because Supabase grants new public views to anon/authenticated by
-- default, the view was readable through the public PostgREST API, bypassing
-- feedback's insert-only RLS — so any holder of the publishable/anon key could
-- read every user's feedback (body, user_id, org_sk). The Supabase dashboard
-- flags this as "Unrestricted".
--
-- Fix (defense in depth, identical to v_audit_recent):
--   1. security_invoker = on  -> the view executes with the CALLER's privileges,
--      so the base table's RLS is enforced; a non-service_role caller sees 0 rows.
--   2. revoke from anon/authenticated -> no public API access at all.
-- service_role (Supabase dashboard / owner triage, and any server-side Edge
-- Function) keeps full read access, which is the intended triage path.

alter view public.v_feedback_recent set (security_invoker = on);

revoke all on public.v_feedback_recent from anon, authenticated;
