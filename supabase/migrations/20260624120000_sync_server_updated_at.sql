-- ─────────────────────────────────────────────────────────────────────────────
-- Incremental-sync foundation: a server-authoritative `server_updated_at` stamp
-- on every synced table, maintained by a BEFORE INSERT/UPDATE trigger.
--
-- Used by the client's manifest-diff pull: it fetches just (pk, server_updated_at)
-- for all of a user's rows (cheap — no JSONB), compares each against the value it
-- stored locally, and downloads the FULL row only where they differ (or are new).
-- So the heavy payload (e.g. inspection_forms.answers/schema_snapshot) transfers
-- only for rows that actually changed.
--
-- Why a NEW column and not `_last_changed_at` / `_version`: those are
-- client-supplied on most writes (and collide across devices), so they can't be
-- trusted as a change cursor. This column is set ONLY by the trigger, to the
-- server clock (microseconds, so writes within one txn stay distinct), on EVERY
-- write — the one reliable "did this row change on the server" signal.
--
-- Additive + backward-compatible: existing rows default to 0 (the client fetches
-- them once on first sync, then skips them while 0 == 0); old app versions ignore
-- the column; clients never send it (the trigger overrides any value).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
  return new;
end;
$$;

-- inspections ──────────────────────────────────────────────────────────────────
alter table public.inspections
  add column if not exists server_updated_at bigint not null default 0;
drop trigger if exists trg_inspections_server_updated_at on public.inspections;
create trigger trg_inspections_server_updated_at
  before insert or update on public.inspections
  for each row execute function public.set_server_updated_at();
create index if not exists idx_inspections_user_server_updated
  on public.inspections (user_id, server_updated_at, inspection_sk);

-- inspection_forms ─────────────────────────────────────────────────────────────
alter table public.inspection_forms
  add column if not exists server_updated_at bigint not null default 0;
drop trigger if exists trg_inspection_forms_server_updated_at on public.inspection_forms;
create trigger trg_inspection_forms_server_updated_at
  before insert or update on public.inspection_forms
  for each row execute function public.set_server_updated_at();
create index if not exists idx_inspection_forms_user_server_updated
  on public.inspection_forms (user_id, server_updated_at, inspection_sk);

-- sms_templates ────────────────────────────────────────────────────────────────
alter table public.sms_templates
  add column if not exists server_updated_at bigint not null default 0;
drop trigger if exists trg_sms_templates_server_updated_at on public.sms_templates;
create trigger trg_sms_templates_server_updated_at
  before insert or update on public.sms_templates
  for each row execute function public.set_server_updated_at();
create index if not exists idx_sms_templates_user_server_updated
  on public.sms_templates (user_id, server_updated_at, sms_template_sk);

-- sms_status ───────────────────────────────────────────────────────────────────
alter table public.sms_status
  add column if not exists server_updated_at bigint not null default 0;
drop trigger if exists trg_sms_status_server_updated_at on public.sms_status;
create trigger trg_sms_status_server_updated_at
  before insert or update on public.sms_status
  for each row execute function public.set_server_updated_at();
create index if not exists idx_sms_status_user_server_updated
  on public.sms_status (user_id, server_updated_at, sms_status_sk);
