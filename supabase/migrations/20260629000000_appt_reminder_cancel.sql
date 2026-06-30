-- Day-before appointment reminders → two-way reply cancel flow.
--
-- This migration prepares the DATA layer for the Twilio reminder epic:
--   1. A new 'CANCELLED' inspection status (a client texting "X" to the reminder
--      cancels their job; CANCELLED is distinct from CLOSED/completed and from
--      the _deleted soft-delete — it gets its own searchable, undoable archive).
--   2. inspections added to the Realtime publication so the assigned inspector's
--      app gets the cancellation live (the inbound Edge Function sets the status
--      server-side; pull-sync remains the fallback).
--   3. A SERVER-ONLY abuse table for unmatched inbound texts, so a spammer who
--      isn't a customer gets counted and auto-blocked instead of running up cost.
--
-- The reminder opt-in (has_appt_reminder / appt_reminder_status) and the org
-- timezone column already exist (20260616000000 / 20260616010000) and are reused.

-- ── 1. status: allow 'CANCELLED' ─────────────────────────────────────────────
-- The original CHECK was added inline by ADD COLUMN, so it carries the
-- deterministic auto-name inspections_status_check. Drop + re-add with the new
-- value. Re-adding under the same name keeps future migrations predictable.
alter table public.inspections
  drop constraint if exists inspections_status_check;

alter table public.inspections
  add constraint inspections_status_check
  check (status in ('OPEN', 'WORK', 'SENT', 'CLOSED', 'CANCELLED'));


-- ── 2. Realtime on inspections ───────────────────────────────────────────────
-- postgres_changes authorization + non-PK filters (user_id) and full OLD images
-- need the whole row in WAL.
alter table public.inspections replica identity full;

-- Add to the Realtime publication once (ADD TABLE errors if already a member).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inspections'
  ) then
    alter publication supabase_realtime add table public.inspections;
  end if;
end $$;


-- ── 3. Inbound abuse tracking (SERVER-ONLY) ──────────────────────────────────
-- One row per unknown sender (a phone that maps to no inspection). The inbound
-- EF increments message_count per junk text and flips blocked=true past the
-- threshold. RLS is ENABLED WITH NO POLICIES, so anon/authenticated have zero
-- access; only the service-role EF (which bypasses RLS) reads/writes it. It is
-- never part of the client sync set.
create table if not exists public.sms_unknown_senders (
  phone         text primary key,         -- last-10-digit normalized
  message_count integer     not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  blocked       boolean     not null default false
);

alter table public.sms_unknown_senders enable row level security;
revoke all on table public.sms_unknown_senders from anon, authenticated;


-- ── 4. Inbound-reply helper functions (service-role only) ────────────────────
-- Phone matching + the "soonest upcoming-not-today (org-local)" pick is done in
-- SQL so it scales (no full-table scan in the EF) and so the today/tomorrow
-- boundary is computed in each org's own timezone via AT TIME ZONE.
--
-- Returns one row: target_sk = the inspection a cancel ("X") should act on (or
-- NULL), known = whether the number matches ANY of our inspections at all (used
-- to decide customer-vs-spam, so a real customer with nothing to cancel is never
-- logged as an unknown sender). Phone match = last-10 digits (US).
create or replace function public.find_reply_target(p_from text)
returns table (target_sk text, known boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits text := right(regexp_replace(coalesce(p_from, ''), '\D', '', 'g'), 10);
  v_known  boolean := false;
  v_target text := null;
begin
  if length(v_digits) < 10 then
    return query select null::text, false;
    return;
  end if;

  select exists(
    select 1 from inspections i
     where coalesce(i._deleted, false) = false
       and i.phone is not null
       and right(regexp_replace(i.phone, '\D', '', 'g'), 10) = v_digits
  ) into v_known;

  select i.inspection_sk into v_target
    from inspections i
    join users u on u.id = i.user_id
    left join organizations o on o.org_sk = u.org_sk
   where coalesce(i._deleted, false) = false
     and i.phone is not null
     and right(regexp_replace(i.phone, '\D', '', 'g'), 10) = v_digits
     and coalesce(i.status, 'OPEN') not in ('CANCELLED', 'CLOSED')
     and o.timezone is not null
     and (i.scheduled_at at time zone o.timezone)::date
       > (now() at time zone o.timezone)::date
   order by i.scheduled_at asc
   limit 1;

  return query select v_target, v_known;
end;
$$;

revoke all on function public.find_reply_target(text) from public, anon, authenticated;
grant execute on function public.find_reply_target(text) to service_role;

-- Atomic "saw another junk text from this unknown number" → returns whether the
-- number is now blocked (count > 5). Avoids a read-modify-write race in the EF.
create or replace function public.bump_unknown_sender(p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blocked boolean;
begin
  insert into sms_unknown_senders (phone, message_count, first_seen_at, last_seen_at, blocked)
  values (p_phone, 1, now(), now(), false)
  on conflict (phone) do update
    set message_count = sms_unknown_senders.message_count + 1,
        last_seen_at  = now(),
        blocked       = (sms_unknown_senders.message_count + 1) > 5
  returning blocked into v_blocked;
  return v_blocked;
end;
$$;

revoke all on function public.bump_unknown_sender(text) from public, anon, authenticated;
grant execute on function public.bump_unknown_sender(text) to service_role;
