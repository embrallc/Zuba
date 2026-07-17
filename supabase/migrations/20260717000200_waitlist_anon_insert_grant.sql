-- FIX staging/prod DRIFT on public.waitlist (found during the getzanbi.com launch).
--
-- 20260716000000_waitlist.sql granted anon + authenticated INSERT on waitlist —
-- the marketing site's logged-out waitlist form depends on it. On PROD that grant
-- is MISSING: during the SEV-0 emergency close (2026-07-16) the anon lockdown was
-- also applied manually + broadly on prod, and a wider `revoke ... on tables from
-- anon` stripped waitlist's INSERT. Because the original waitlist migration was
-- already recorded as applied, it never re-ran to restore it. Staging (migrations
-- only; the file's revoke is default-privileges = FUTURE tables only) kept the
-- grant. Net effect, prod ONLY:
--     POST /rest/v1/waitlist  ->  401  42501 "permission denied for table waitlist"
--
-- Re-assert the waitlist migration's exact privilege floor, idempotently: a no-op
-- on staging (already correct), a restore on prod. RLS, the insert-only policy,
-- and the append-only design are unchanged — this only restores the table-level
-- INSERT privilege the policy needs in order to take effect.

revoke all    on public.waitlist from anon;
revoke all    on public.waitlist from authenticated;
grant  insert on public.waitlist to   anon;
grant  insert on public.waitlist to   authenticated;
grant  all    on public.waitlist to   service_role;
