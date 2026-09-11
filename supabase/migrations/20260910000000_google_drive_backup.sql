-- ─────────────────────────────────────────────────────────────────────────────
-- Google Drive Backup (P1) — BYO-account archive of completed inspections.
--
-- State boards require inspectors to retain records ~3–5 years (some push to 7)
-- and we offer no backup today. The owner connects their own Google Drive once;
-- from then on every COMPLETED inspection is mirrored into their Drive:
--
--   My Drive / Zanbi Inspections / 2026 / 123 Main St - John Doe (Sep 5) /
--     Final_Report_*.pdf + inspection_data.json + Raw_Photos/*.jpg
--
-- ⭐ THE CORE SEMANTIC: the Drive folder MIRRORS the completed record. The unit
-- of work is the WHOLE INSPECTION, not one file. Any report record written for a
-- CLOSED inspection triggers a full re-sync that overwrites everything, so the
-- restore→edit→complete-again loop and a plain re-Generate both converge to
-- "Drive equals the current state" — no duplicate files, no stale PDF.
--
-- Four tables, ALL SERVICE-ROLE ONLY (RLS on, no policies, privileges revoked
-- from anon/authenticated — same posture as report_shares). The app reads its
-- status through the drive-status Edge Function, never from these tables.
--
--   drive_connections — one per ORG (the owner's Drive). The refresh token is
--                       NOT stored here: it lives in Supabase Vault, reachable
--                       only through the service-role RPCs below.
--   drive_folders     — Drive folder-id cache. `drive.file` scope can only see
--                       files WE created, so we must remember every id we make.
--   drive_syncs       — ⭐ the unit of work: one claimable row per inspection.
--   drive_backups     — the file ledger the sync diffs against (one row/file).
--
-- Deleting an inspection cascades our bookkeeping away but deliberately leaves
-- the files in the inspector's Drive — they own that archive, and destroying a
-- retention record from a cascade would defeat the entire point of the feature.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── One-time owner prompt flag ───────────────────────────────────────────────
-- Backups are FORWARD-ONLY (no backfill), so owners must be told to connect
-- early. Org-level + one-way, exactly like has_seen_walkthrough_intro: set once,
-- never re-shown, even if a different member signs in.
alter table public.organizations
  add column if not exists has_seen_drive_prompt boolean not null default false;

grant update (has_seen_drive_prompt) on public.organizations to authenticated;

-- ── drive_connections ────────────────────────────────────────────────────────
create table if not exists public.drive_connections (
  org_sk           uuid primary key references public.organizations (org_sk) on delete cascade,
  status           text not null default 'pending'
                     check (status in ('pending', 'connected', 'revoked', 'error')),
  backup_enabled   boolean not null default true,   -- owner's master switch
  google_email     text,                            -- shown as "Connected as …"
  secret_id        uuid,                            -- vault.secrets id (refresh token)
  -- Short-lived OAuth handshake state. Written by drive-connect-start, consumed
  -- (and cleared) by drive-oauth-callback. `oauth_state` is the CSRF token and
  -- the only thing tying Google's redirect back to this org.
  oauth_state      text,
  oauth_verifier   text,                            -- PKCE code_verifier
  oauth_return_to  text,                            -- app deep link to bounce to
  oauth_expires_at timestamptz,
  connected_by     uuid references auth.users (id) on delete set null,
  connected_at     timestamptz,
  last_backup_at   timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The callback looks the pending connection up by state alone (it holds no JWT).
create index if not exists drive_connections_state_idx
  on public.drive_connections (oauth_state)
  where oauth_state is not null;

alter table public.drive_connections enable row level security;
revoke all on public.drive_connections from anon, authenticated;
grant all on public.drive_connections to service_role;

-- ── drive_folders ────────────────────────────────────────────────────────────
-- path_key is our stable handle for a folder; `name` and `parent_key` record what
-- we last synced so the runner can detect a RENAME (client/address edited) or a
-- MOVE (date edited across a year boundary) and fix it in place, keeping the same
-- Drive id instead of creating a second folder.
create table if not exists public.drive_folders (
  id              uuid primary key default gen_random_uuid(),
  org_sk          uuid not null references public.organizations (org_sk) on delete cascade,
  path_key        text not null,   -- 'root' | 'year:2026' | 'insp:<sk>' | 'insp:<sk>/photos'
  drive_folder_id text not null,
  name            text,
  parent_key      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_sk, path_key)
);

alter table public.drive_folders enable row level security;
revoke all on public.drive_folders from anon, authenticated;
grant all on public.drive_folders to service_role;

-- ── drive_syncs ──────────────────────────────────────────────────────────────
-- One row per inspection = one claimable job. `status` is claimed atomically
-- (pending|failed -> running) so concurrent nudges can't double-create folders.
-- `claimed_at` doubles as a heartbeat refreshed each batch, so the sweep can tell
-- a long photo run apart from a crashed one. `resync_requested` coalesces a new
-- report record that lands mid-run: the in-flight pass re-queues itself instead
-- of leaving Drive one revision behind.
create table if not exists public.drive_syncs (
  inspection_sk    text primary key references public.inspections (inspection_sk) on delete cascade,
  org_sk           uuid not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'running', 'done', 'failed')),
  revision         uuid,            -- inspection_reports.report_sk that triggered it
  resync_requested boolean not null default false,
  claimed_at       timestamptz,
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  files_done       int not null default 0,
  files_total      int not null default 0,
  synced_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists drive_syncs_due_idx
  on public.drive_syncs (status, next_attempt_at);

alter table public.drive_syncs enable row level security;
revoke all on public.drive_syncs from anon, authenticated;
grant all on public.drive_syncs to service_role;

-- ── drive_backups (the file ledger) ──────────────────────────────────────────
-- `source_path` is the Storage path we last mirrored. Stored photo objects are
-- immutable (editing markup writes a NEW burnedCloudUri), so an unchanged
-- source_path provably means the Drive copy already matches — that's what keeps a
-- re-Generate from re-uploading 100 identical photos. The PDF and the JSON are
-- derived from the whole record, so they're rewritten on every sync regardless.
create table if not exists public.drive_backups (
  id            uuid primary key default gen_random_uuid(),
  org_sk        uuid not null,
  inspection_sk text not null references public.inspections (inspection_sk) on delete cascade,
  artifact      text not null,   -- 'report_pdf' | 'data_json' | 'photo:<photoId>'
  source_path   text,
  drive_file_id text,
  status        text not null default 'pending'
                  check (status in ('pending', 'done', 'failed', 'skipped', 'trashed')),
  attempts      int not null default 0,
  last_error    text,
  backed_up_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (inspection_sk, artifact)   -- ⭐ the per-file idempotency key
);

create index if not exists drive_backups_inspection_idx
  on public.drive_backups (inspection_sk);
create index if not exists drive_backups_recent_idx
  on public.drive_backups (org_sk, backed_up_at desc);

alter table public.drive_backups enable row level security;
revoke all on public.drive_backups from anon, authenticated;
grant all on public.drive_backups to service_role;

-- ── Vault access for the refresh token ───────────────────────────────────────
-- The `vault` schema is NOT exposed to PostgREST, so the Edge Functions reach it
-- through these three SECURITY DEFINER RPCs. Per the anon-privilege SEV-0 rule:
-- revoke from everyone, then GRANT EXECUTE explicitly to service_role only —
-- never to anon or authenticated.
create or replace function public.drive_secret_name(p_org_sk uuid)
returns text
language sql
immutable
as $$ select 'drive_refresh_' || replace(p_org_sk::text, '-', '') $$;

create or replace function public.drive_secret_put(p_org_sk uuid, p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := public.drive_secret_name(p_org_sk);
  v_id   uuid;
begin
  if p_org_sk is null or coalesce(p_token, '') = '' then
    raise exception 'drive_secret_put: org_sk and token are required';
  end if;
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    v_id := vault.create_secret(p_token, v_name, 'Google Drive refresh token (per org)');
  else
    perform vault.update_secret(v_id, p_token);
  end if;
  return v_id;
end;
$$;

create or replace function public.drive_secret_get(p_org_sk uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = public.drive_secret_name(p_org_sk);
  return v_token;
end;
$$;

create or replace function public.drive_secret_del(p_org_sk uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from vault.secrets where name = public.drive_secret_name(p_org_sk);
end;
$$;

revoke all on function public.drive_secret_put(uuid, text) from public, anon, authenticated;
revoke all on function public.drive_secret_get(uuid)       from public, anon, authenticated;
revoke all on function public.drive_secret_del(uuid)       from public, anon, authenticated;
grant execute on function public.drive_secret_put(uuid, text) to service_role;
grant execute on function public.drive_secret_get(uuid)       to service_role;
grant execute on function public.drive_secret_del(uuid)       to service_role;

-- ── Nudge the runner over pg_net ─────────────────────────────────────────────
-- Mirrors fire_feedback_notify / the reconcile sweep: read project_url +
-- service_role_key from Vault, POST the Edge Function. net.http_post QUEUES
-- asynchronously, so this NEVER blocks or slows report generation. Warn-and-skip
-- when the Vault secrets are absent so the migration is safe to apply first.
create or replace function public.fire_drive_sync(p_inspection_sk text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'fire_drive_sync: missing vault secrets project_url/service_role_key — skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/drive-backup',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('inspectionSk', p_inspection_sk)
  );
end;
$$;

revoke all on function public.fire_drive_sync(text) from public, anon, authenticated;

-- ── The trigger: any report record for a CLOSED inspection = re-sync ─────────
-- inspection_reports INSERT is the ONE canonical "a report artifact exists" event
-- and is hit by all three producers (the worker job path, /api/render-internal on
-- auto-send, and the legacy generate-report EF). Deliberately NOT hooked to
-- reconcile-inspection, which short-circuits (skip_manual_path) whenever auto-send
-- is off and would silently skip every org that emails reports by hand.
create or replace function public.trg_drive_sync_on_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_status  text;
  v_ok      boolean;
begin
  -- Resolve the org (the report row's own, else the generating user's).
  v_org := new.org_sk;
  if v_org is null and new.user_id is not null then
    select org_sk into v_org from public.users where id = new.user_id;
  end if;
  if v_org is null then
    return null;
  end if;

  -- COMPLETED inspections only — mid-inspection "Generate" previews must never
  -- litter the inspector's Drive.
  select status into v_status
    from public.inspections
   where inspection_sk = new.inspection_sk;
  if coalesce(v_status, 'OPEN') <> 'CLOSED' then
    return null;
  end if;

  -- Only orgs with a live connection and backups switched on.
  select true into v_ok
    from public.drive_connections
   where org_sk = v_org
     and status = 'connected'
     and backup_enabled is true;
  if v_ok is not true then
    return null;
  end if;

  -- Queue the whole-record sync. If one is already RUNNING we leave it running
  -- and set resync_requested, so the in-flight pass re-queues itself rather than
  -- finishing against a state that has since moved on.
  insert into public.drive_syncs (
    inspection_sk, org_sk, status, revision, attempts, next_attempt_at, updated_at
  )
  values (new.inspection_sk, v_org, 'pending', new.report_sk, 0, now(), now())
  on conflict (inspection_sk) do update
     set org_sk           = excluded.org_sk,
         revision         = excluded.revision,
         attempts         = 0,
         next_attempt_at  = now(),
         last_error       = null,
         updated_at       = now(),
         resync_requested = (drive_syncs.status = 'running'),
         status           = case
                              when drive_syncs.status = 'running' then 'running'
                              else 'pending'
                            end;

  perform public.fire_drive_sync(new.inspection_sk);
  return null; -- AFTER trigger: return value is ignored.
end;
$$;

revoke all on function public.trg_drive_sync_on_report() from public, anon, authenticated;

drop trigger if exists drive_sync_on_report_ins on public.inspection_reports;
create trigger drive_sync_on_report_ins
  after insert on public.inspection_reports
  for each row
  execute function public.trg_drive_sync_on_report();

-- ── Cron backstop ────────────────────────────────────────────────────────────
-- The live nudge above is the fast path; a dropped pg_net request or a crashed
-- run would otherwise strand a sync forever. Every 5 minutes: recover stale
-- claims, then re-drive anything due. The runner owns ALL the sync logic — this
-- only decides which rows are worth a nudge.
create or replace function public.sweep_drive_syncs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
  r     record;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'sweep_drive_syncs: missing vault secrets project_url/service_role_key — skipping';
    return;
  end if;

  -- A batch refreshes claimed_at as a heartbeat, so 15 minutes of silence means
  -- the run died mid-flight. Flip it back so it can be claimed again; the diff is
  -- declarative, so re-running from scratch is always safe.
  update public.drive_syncs
     set status     = 'failed',
         last_error = coalesce(last_error, 'sync stalled (no heartbeat)'),
         updated_at = now()
   where status = 'running'
     and coalesce(claimed_at, updated_at) < now() - interval '15 minutes';

  for r in
    select s.inspection_sk
      from public.drive_syncs s
      join public.drive_connections c
        on c.org_sk = s.org_sk
       and c.status = 'connected'
       and c.backup_enabled is true
     where s.status in ('pending', 'failed')
       and s.attempts < 5
       and s.next_attempt_at <= now()
     order by s.next_attempt_at asc
     limit 25
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/drive-backup',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_key
                 ),
      body    := jsonb_build_object('inspectionSk', r.inspection_sk)
    );
  end loop;
end;
$$;

revoke all on function public.sweep_drive_syncs() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'drive-backup-sweep') then
    perform cron.unschedule('drive-backup-sweep');
  end if;
end $$;

select cron.schedule(
  'drive-backup-sweep',
  '*/5 * * * *',
  $$ select public.sweep_drive_syncs(); $$
);
