-- Appointment reminders: (1) re-arm on reschedule/restore/un-cancel, and
-- (2) make the daily sweep scale set-based instead of an org-by-org N+1 loop.
--
-- BACKGROUND / the misses this fixes
-- The day-before reminder flips appt_reminder_status PENDING -> SENT so a client
-- is texted at most once. But three real edits left a stale SENT with no resend:
--   1. Client cancels (X reply -> CANCELLED), inspector reschedules/un-cancels for
--      a new date/time  -> still SENT -> no fresh reminder.
--   2. Inspector deletes, then restores from the deleted archive (_deleted 1->0)
--      -> still SENT -> no fresh reminder.
--   3. Inspector just drag-reschedules to a new time -> still SENT -> the client
--      never learns the time changed.
--
-- FIX 1 — re-arm trigger (below): a BEFORE UPDATE trigger flips SENT -> PENDING
-- whenever scheduled_at changes, the row is restored (_deleted true->false), or it
-- transitions OUT of CANCELLED. Living in the DB (not the client) means it fires
-- no matter which path/device made the edit, and it deterministically WINS over
-- the offline sync push: when the client pushes its stale SENT during a reschedule,
-- this trigger runs on that very upsert and overrides NEW back to PENDING; the
-- server_updated_at trigger then stamps it so the next pull carries PENDING down.
--
-- Why it can't loop or misfire: the sweep's own flip only touches
-- appt_reminder_status/_version/_last_changed_at (none of the three conditions),
-- so it never re-arms itself; a push that re-sends the same scheduled_at is NOT
-- DISTINCT so it's a no-op; and moving INTO 'CANCELLED' (OLD='OPEN') doesn't match.
--
-- FIX 2 — scale (partial index + due_appt_reminders()): the sweep used to load
-- every org each hour and run a per-org users+inspections query (N+1). Widening the
-- send window from "exactly 10am" to "9am or later" would have made each org run
-- that inner pair ~12-15x/day. Instead we expose ONE set-based, index-backed query
-- returning exactly the rows to text right now, so the sweep scales with
-- "reminders due in the next ~day" (always small) rather than total org/user count.

-- ── FIX 1: re-arm trigger ────────────────────────────────────────────────────
create or replace function public.rearm_appt_reminder()
returns trigger
language plpgsql
as $$
begin
  -- Only re-arm an opted-in row that is currently SENT (skip no-op churn on rows
  -- already PENDING, which would needlessly bump server_updated_at).
  if new.has_appt_reminder is true
     and new.appt_reminder_status is distinct from 'PENDING'
     and (
          new.scheduled_at is distinct from old.scheduled_at                  -- rescheduled (date OR time)
       or (old._deleted is true  and coalesce(new._deleted, false) is false)  -- restored from deleted
       or (old.status = 'CANCELLED' and new.status is distinct from 'CANCELLED') -- un-cancelled
     )
  then
    new.appt_reminder_status := 'PENDING';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inspections_rearm_reminder on public.inspections;
create trigger trg_inspections_rearm_reminder
  before update on public.inspections
  for each row execute function public.rearm_appt_reminder();

-- ── FIX 2a: partial index (the scaling lever) ────────────────────────────────
-- PENDING + opted-in is a tiny slice of the table, so this keeps the sweep query
-- O(reminders-pending-soon) even as `inspections` grows to millions of history rows.
create index if not exists idx_inspections_due_reminder
  on public.inspections (scheduled_at)
  where has_appt_reminder = true
    and appt_reminder_status = 'PENDING'
    and _deleted = false;

-- ── FIX 2b: set-based "what should we text right now" query ───────────────────
-- Returns exactly the inspections to remind: opted-in, still PENDING, not deleted,
-- non-terminal, with a phone, whose appointment is TOMORROW in the org's tz and
-- whose org-local hour is >= p_min_hour. All tz math is done here (Postgres) so the
-- Edge Function just loops the small result and sends.
--   p_min_hour : org-local send floor (9 = no texts before 9am). Test hooks pass a
--                negative value to bypass the hour gate.
--   p_org_sk   : optional single-org scope for the manual test hook.
-- The coarse scheduled_at band lets the partial index prune before the exact
-- tz-date equality runs on the survivors. Null org timezone falls back to Central
-- (paired with the client healing the org's real device zone on first load).
-- NOTE: org_sk is UUID on both organizations and users (see
-- 20260518020000_org_sk_server_uuid.sql), so p_org_sk must be uuid — comparing a
-- uuid column to a text param throws "operator does not exist: uuid = text".
create or replace function public.due_appt_reminders(
  p_min_hour int default 9,
  p_org_sk   uuid default null
)
returns table (
  inspection_sk  text,
  phone          text,
  scheduled_at   timestamptz,
  timezone       text,
  inspector_name text,
  version        bigint
)
language sql
security definer
set search_path = public
as $$
  select
    i.inspection_sk,
    i.phone,
    i.scheduled_at,
    coalesce(o.timezone, 'America/Chicago')            as timezone,
    btrim(concat_ws(' ', u.fname, u.lname))            as inspector_name,
    coalesce(i._version, 1)::bigint                     as version
  from inspections i
  join users u          on u.id = i.user_id
  left join organizations o on o.org_sk = u.org_sk
  where i.has_appt_reminder = true
    and i.appt_reminder_status = 'PENDING'
    and coalesce(i._deleted, false) = false
    and coalesce(i.status, 'OPEN') not in ('CANCELLED', 'CLOSED')
    and i.phone is not null
    and i.scheduled_at >= now()
    and i.scheduled_at <  now() + interval '50 hours'          -- index-pruning band
    and (p_org_sk is null or o.org_sk = p_org_sk)
    and extract(hour from (now() at time zone coalesce(o.timezone, 'America/Chicago'))) >= p_min_hour
    and (i.scheduled_at at time zone coalesce(o.timezone, 'America/Chicago'))::date
      = (now()          at time zone coalesce(o.timezone, 'America/Chicago'))::date + 1;
$$;

-- Internal only — the sweep EF calls this with the service-role key.
revoke all on function public.due_appt_reminders(int, uuid) from public, anon, authenticated;
grant execute on function public.due_appt_reminders(int, uuid) to service_role;
