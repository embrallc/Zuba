-- Database change-data-capture / audit trail via supa_audit, extended with actor
-- info, plus a 60-day retention purge.
--
-- supa_audit captures every INSERT/UPDATE/DELETE on the tracked tables into
-- audit.record_version (op, ts, table_name, `record` = new row jsonb, `old_record`
-- = old row jsonb). We EXTEND it with two actor columns — WITHOUT forking its
-- trigger — by giving them column DEFAULTs. supa_audit's INSERT doesn't list these
-- columns, so the DEFAULT fires on every audit row:
--
--   actor_uid   = auth.uid()          → the signed-in user (NULL when not a user)
--   actor_role  = JWT 'role' claim     → 'authenticated' = a USER DEVICE (the write
--                                        arrived via the app's authenticated sync
--                                        push); 'service_role' = a SERVER write
--                                        (Edge Function / cron worker) that happened
--                                        server-first; 'anon'; or NULL = a DB-internal
--                                        write (pg_cron / a migration / direct SQL).
--
-- This is the "user device vs server-first" signal the audit needs. It works even
-- though supa_audit's trigger is SECURITY DEFINER, because auth.uid() and
-- request.jwt.claims are REQUEST-scoped GUCs — a definer context changes the role,
-- not the session GUCs — so they still reflect the original caller.
--
-- NOTE on offline-first: a client-side process (e.g. the calendar reconciler's
-- vanish-delete) reaches the cloud as the USER's authenticated sync push, so it is
-- recorded as actor_role='authenticated'. Distinguishing the *mechanism* of a
-- user-originated change needs client telemetry (a logEvent), not this audit.
--
-- Privacy: audit.record_version lives in the private `audit` schema, which is not
-- exposed to the Data API and isn't covered by the public-schema blanket grants —
-- so only the dashboard / service role can read it. No RLS needed.

-- ── Extension ────────────────────────────────────────────────────────────────
create extension if not exists supa_audit cascade;

-- ── Actor columns (populated by DEFAULT during supa_audit's own INSERT) ───────
alter table audit.record_version
  add column if not exists actor_uid uuid default auth.uid();
alter table audit.record_version
  add column if not exists actor_role text
    default (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');

-- ── Enable tracking on the core tables (idempotent) ──────────────────────────
-- Deliberately excludes inspection_forms: its schema_snapshot/answers JSONB is
-- large and written often, so auditing it would bloat the trail fast. Add it later
-- with `select audit.enable_tracking('public.inspection_forms'::regclass);` if the
-- full form history is worth the volume.
do $$
declare
  tbl text;
  targets text[] := array[
    'public.inspections',
    'public.organizations',
    'public.users',
    'public.sms_templates'
  ];
begin
  foreach tbl in array targets loop
    if not exists (
      select 1
        from pg_trigger tg
        join pg_proc p on p.oid = tg.tgfoid
        join pg_namespace n on n.oid = p.pronamespace
       where tg.tgrelid = tbl::regclass
         and n.nspname = 'audit'
         and p.proname = 'insert_update_delete_trigger'
    ) then
      perform audit.enable_tracking(tbl::regclass);
    end if;
  end loop;
end $$;

-- ── Convenience view: recent changes with a human "actor_type" ───────────────
-- security_invoker so it inherits the caller's (lack of) privileges on the audit
-- table → effectively dashboard/service-role only, same as the table itself.
create or replace view public.v_audit_recent
  with (security_invoker = on) as
  select
    ts,
    table_schema,
    table_name,
    op,
    case
      when actor_role = 'authenticated' then 'user_device'
      when actor_role = 'service_role'  then 'server'
      when actor_role is null           then 'system'      -- cron / migration / direct
      else actor_role
    end as actor_type,
    actor_uid,
    actor_role,
    record_id,
    old_record,
    record
  from audit.record_version
  order by ts desc;

revoke all on public.v_audit_recent from anon, authenticated;

-- ── Retention: nightly purge of audit rows older than 60 days (mirrors
--    prune_app_logs). Offset from the other 3am jobs. ──────────────────────────
create or replace function public.prune_audit_log()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from audit.record_version where ts < now() - interval '60 days';
$$;
revoke all on function public.prune_audit_log() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-audit-log') then
    perform cron.unschedule('prune-audit-log');
  end if;
end $$;

select cron.schedule('prune-audit-log', '45 3 * * *', $$ select public.prune_audit_log(); $$);
