-- ─────────────────────────────────────────────────────────────────────────────
-- Google Drive Backup — sync on COMPLETION, then on any later change.
--
-- The first cut triggered only on inspection_reports INSERT, which left a hole:
-- an org with BOTH report types disabled never renders a report, so no row is
-- ever written and the inspection was never archived at all — not even its
-- photos or its record, which is exactly what retention rules are about.
--
-- The model this replaces it with:
--   1. COMPLETION is the trigger. When an inspection closes we archive whatever
--      exists at that moment — PDF, interactive HTML, both, or neither.
--   2. ANY later change re-mirrors the WHOLE folder. The runner's diff is
--      declarative, so nothing has to work out what changed: re-run it and the
--      folder converges on the current record.
--
-- Sources of "any later change", each guarded so routine sync churn (_version
-- bumps, report_state transitions) can't fire a pointless re-mirror:
--   • inspections        — the address/client/date/payment fields the folder
--                          name and inspection_data.json are built from
--   • inspection_forms   — the answers blob, i.e. every photo and field value
--   • inspection_reports — a newly generated PDF / online report
--
-- Debounce: completion waits ~3 min so an in-flight render can land in the same
-- pass, and edits wait ~2 min so a burst of them collapses into one sync. Those
-- enqueues deliberately do NOT nudge the function — they ride the 5-minute cron
-- sweep, which is what makes the debounce real (the nudge path claims a row
-- immediately, ignoring next_attempt_at). A new report row is the one event that
-- fires immediately: it means someone is waiting on that artifact.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Shared enqueue ───────────────────────────────────────────────────────────
-- One place for the guards (org resolution, CLOSED-only, live connection) and
-- the coalescing upsert, so every trigger below is three lines.
-- Returns true when a sync was queued.
create or replace function public.enqueue_drive_sync(
  p_inspection_sk text,
  p_revision      uuid     default null,
  p_delay         interval default interval '0'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_status text;
  v_user   uuid;
  v_ok     boolean;
begin
  if p_inspection_sk is null then
    return false;
  end if;

  select i.org_sk, i.status, i.user_id
    into v_org, v_status, v_user
    from public.inspections i
   where i.inspection_sk = p_inspection_sk
     and coalesce(i._deleted, false) = false;

  -- COMPLETED inspections only — a mid-inspection "Generate" preview must never
  -- litter the inspector's Drive.
  if coalesce(v_status, 'OPEN') <> 'CLOSED' then
    return false;
  end if;

  if v_org is null and v_user is not null then
    select org_sk into v_org from public.users where id = v_user;
  end if;
  if v_org is null then
    return false;
  end if;

  -- Only orgs with a live connection and backups switched on.
  select true into v_ok
    from public.drive_connections
   where org_sk = v_org
     and status = 'connected'
     and backup_enabled is true;
  if v_ok is not true then
    return false;
  end if;

  insert into public.drive_syncs (
    inspection_sk, org_sk, status, revision, attempts, next_attempt_at, updated_at
  )
  values (p_inspection_sk, v_org, 'pending', p_revision, 0, now() + p_delay, now())
  on conflict (inspection_sk) do update
     set org_sk           = excluded.org_sk,
         revision         = coalesce(excluded.revision, drive_syncs.revision),
         attempts         = 0,
         last_error       = null,
         updated_at       = now(),
         -- A shorter delay wins: an immediate event arriving during a debounce
         -- window pulls the sync forward instead of being held back by it.
         next_attempt_at  = least(drive_syncs.next_attempt_at, now() + p_delay),
         resync_requested = (drive_syncs.status = 'running'),
         status           = case
                              when drive_syncs.status = 'running' then 'running'
                              else 'pending'
                            end;

  -- Only an immediate enqueue nudges the runner; a debounced one waits for the
  -- cron sweep, which honours next_attempt_at.
  if p_delay <= interval '0' then
    perform public.fire_drive_sync(p_inspection_sk);
  end if;
  return true;
end;
$$;

revoke all on function public.enqueue_drive_sync(text, uuid, interval)
  from public, anon, authenticated;

-- ── 1. A generated report (PDF or interactive) — fire immediately ────────────
create or replace function public.trg_drive_sync_on_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enqueue_drive_sync(new.inspection_sk, new.report_sk, interval '0');
  return null;
end;
$$;

revoke all on function public.trg_drive_sync_on_report() from public, anon, authenticated;

drop trigger if exists drive_sync_on_report_ins on public.inspection_reports;
create trigger drive_sync_on_report_ins
  after insert on public.inspection_reports
  for each row
  execute function public.trg_drive_sync_on_report();

-- ── 2. The inspection itself: completion, and later edits ────────────────────
-- Column-scoped on purpose. inspections is UPDATEd constantly by device sync
-- (_version, _last_changed_at, server_updated_at) and by the auto-send loop
-- (report_state pending -> sending -> sent); firing on those would re-mirror the
-- folder for nothing. Only fields the ARCHIVE actually renders count: the folder
-- name (address / client / date) and inspection_data.json.
create or replace function public.trg_drive_sync_on_inspection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_just_closed boolean;
  v_changed     boolean;
begin
  if coalesce(new._deleted, false) then
    return null;
  end if;
  if coalesce(new.status, 'OPEN') <> 'CLOSED' then
    return null;   -- reopened: leave Drive alone until it's completed again
  end if;

  v_just_closed := coalesce(old.status, 'OPEN') is distinct from 'CLOSED';

  v_changed :=
       old.full_name     is distinct from new.full_name
    or old.address_line1 is distinct from new.address_line1
    or old.address_line2 is distinct from new.address_line2
    or old.city          is distinct from new.city
    or old.state         is distinct from new.state
    or old.zip_code      is distinct from new.zip_code
    or old.email         is distinct from new.email
    or old.phone         is distinct from new.phone
    or old.summary       is distinct from new.summary
    or old.scheduled_at  is distinct from new.scheduled_at
    or old.paid          is distinct from new.paid
    or old.payment_state is distinct from new.payment_state;

  if v_just_closed then
    -- Archive what exists. The wait lets an in-flight render land so the PDF /
    -- interactive report ride the same pass; if none is coming (both report
    -- types off) the sweep still archives the photos and the record.
    perform public.enqueue_drive_sync(new.inspection_sk, null, interval '3 minutes');
  elsif v_changed then
    perform public.enqueue_drive_sync(new.inspection_sk, null, interval '2 minutes');
  end if;
  return null;
end;
$$;

revoke all on function public.trg_drive_sync_on_inspection() from public, anon, authenticated;

drop trigger if exists drive_sync_on_inspection_upd on public.inspections;
create trigger drive_sync_on_inspection_upd
  after update on public.inspections
  for each row
  execute function public.trg_drive_sync_on_inspection();

-- ── 3. The walkthrough answers: photos and field values ──────────────────────
-- answers is the blob every photo lives in, so this is what catches a photo
-- added or removed on a completed inspection. Compared with IS DISTINCT FROM so
-- a no-op push of the same blob doesn't re-mirror.
create or replace function public.trg_drive_sync_on_form()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new._deleted, false) then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.answers is not distinct from new.answers then
    return null;
  end if;
  perform public.enqueue_drive_sync(new.inspection_sk, null, interval '2 minutes');
  return null;
end;
$$;

revoke all on function public.trg_drive_sync_on_form() from public, anon, authenticated;

drop trigger if exists drive_sync_on_form_change on public.inspection_forms;
create trigger drive_sync_on_form_change
  after insert or update on public.inspection_forms
  for each row
  execute function public.trg_drive_sync_on_form();
