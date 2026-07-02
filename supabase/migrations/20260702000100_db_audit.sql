-- Database change-data-capture / audit trail — custom trigger (NOT supa_audit).
--
-- Why not supa_audit: the extension is bundled in the local `supabase/postgres`
-- Docker image (so `supabase db reset` passes locally) but is NOT available on the
-- hosted platform — `create extension supa_audit` fails there with "extension is
-- not available". So we roll the same thing ourselves: one audit table + one
-- generic row trigger. No external dependency, works on every environment.
--
-- Captures every INSERT/UPDATE/DELETE on the tracked tables into
-- audit.record_version with the new row (`record`) and old row (`old_record`) as
-- JSONB, plus the actor:
--   actor_uid  = JWT 'sub'  → the signed-in user (NULL when not a user request)
--   actor_role = JWT 'role' → 'authenticated' = a USER DEVICE (arrived via the
--                             app's authenticated sync push); 'service_role' = a
--                             SERVER write (Edge Function / cron worker) that
--                             happened server-first; NULL = a DB-internal write
--                             (pg_cron / a migration / direct SQL).
-- The trigger is SECURITY DEFINER (so it can write the private audit table no
-- matter who triggered it); auth claims come from request.jwt.claims, a
-- request-scoped GUC unaffected by the definer context, so they reflect the
-- ORIGINAL caller — the "user device vs server-first" signal.
--
-- NOTE (offline-first): a client-side process (e.g. the calendar reconciler's
-- vanish-delete) reaches the cloud as the USER's authenticated sync push, so it is
-- recorded as actor_role='authenticated'. Telling apart the *mechanism* of a
-- user-originated change needs client telemetry, not this audit.
--
-- Privacy: the audit schema is not exposed to the Data API and gets no anon/
-- authenticated grants, so it's dashboard/service-role only. Retention: nightly
-- pg_cron purge of rows older than 60 days.

create schema if not exists audit;

create table if not exists audit.record_version (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  table_schema  text not null,
  table_name    text not null,
  op            text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  record        jsonb,       -- new row (NULL on DELETE)
  old_record    jsonb,       -- old row (NULL on INSERT)
  actor_uid     uuid,        -- JWT sub  (NULL = not a user request)
  actor_role    text         -- JWT role (authenticated / service_role / NULL)
);

create index if not exists record_version_ts_idx
  on audit.record_version (ts desc);
create index if not exists record_version_table_ts_idx
  on audit.record_version (table_name, ts desc);

-- Generic capture trigger. SECURITY DEFINER so the write into the private audit
-- table succeeds regardless of the caller's (lack of) privileges on it.
create or replace function audit.capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  insert into audit.record_version(
    table_schema, table_name, op, record, old_record, actor_uid, actor_role
  )
  values (
    tg_table_schema,
    tg_table_name,
    tg_op,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    nullif(v_claims ->> 'sub', '')::uuid,
    v_claims ->> 'role'
  );
  return null; -- AFTER trigger; return value is ignored
end;
$$;

-- Attach to the core business tables (idempotent). inspection_forms is left out on
-- purpose — its schema_snapshot/answers JSONB is large and written often, so
-- auditing it would bloat the trail; add a trigger later if the history is worth it.
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
    execute format('drop trigger if exists audit_capture on %s', tbl);
    execute format(
      'create trigger audit_capture after insert or update or delete on %s
         for each row execute function audit.capture()', tbl);
  end loop;
end $$;

-- Convenience view: recent changes with a human "actor_type".
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
    record,
    old_record
  from audit.record_version
  order by ts desc;

revoke all on public.v_audit_recent from anon, authenticated;

-- Retention: nightly purge of audit rows older than 60 days (offset from the other
-- 3am jobs).
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
