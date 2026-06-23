-- P3 backstop: a pg_cron safety sweep that re-drives CLOSED inspections whose
-- auto-release report never reached a terminal state.
--
-- Correctness of the auto-comms loop normally comes from two live triggers:
--   (a) the device, right after Complete, and
--   (b) the Stripe webhook, right after marking paid.
-- Both fire-and-forget an invoke of reconcile-inspection, so a dropped request
-- (device offline, interrupted call, lost webhook nudge) could strand a report
-- in 'pending'/'held'/'failed' forever. This sweep is the convergence backstop:
-- every 5 minutes it asks the (idempotent) reconciler to converge any stuck
-- row. The reconciler owns ALL the policy/gate/claim logic — the sweep only
-- decides which rows are worth a nudge.
--
-- Secrets: the cron function calls the Edge Function over HTTP via pg_net, so it
-- needs the project URL + the service-role key. Those are NOT committed here —
-- they live in Supabase Vault and must be seeded ONCE (see the block at the
-- bottom of this file). The function no-ops with a warning until they exist, so
-- this migration is safe to apply before seeding.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Sweep function ───────────────────────────────────────────────────────────
create or replace function public.sweep_unsent_reports()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_stale_ms bigint := 15 * 60 * 1000; -- 15 min: a real send takes seconds
  r record;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'sweep_unsent_reports: missing vault secrets project_url/service_role_key — skipping';
    return;
  end if;

  -- Recover reports stuck mid-send: an EF crash after the 'sending' claim but
  -- before setting 'sent'/'failed' would otherwise never re-drive (the claim
  -- only fires from pending/held/failed). After 15 min, flip back to 'failed'.
  update public.inspections
     set report_state = 'failed'
   where status = 'CLOSED'
     and report_state = 'sending'
     and coalesce(_last_changed_at, 0) < v_now - v_stale_ms;

  -- Nudge the reconciler for each CLOSED row that hasn't settled. We include
  -- not-yet-snapshotted rows (policy IS NULL → offline complete that never had
  -- its first sighting) but skip rows we already know are manual-only
  -- (policy_auto_send_report = false), so those don't get called every cycle.
  for r in
    select inspection_sk
      from public.inspections
     where status = 'CLOSED'
       and coalesce(_deleted, false) = false
       and (
            (report_state in ('pending', 'failed')
              and coalesce(policy_auto_send_report, true) = true)
         or (report_state = 'held' and paid = true)
       )
     order by _last_changed_at asc nulls first
     limit 50
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/reconcile-inspection',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_key
                 ),
      body    := jsonb_build_object('inspectionSk', r.inspection_sk)
    );
  end loop;
end;
$$;

-- Only the scheduler (postgres) should run this; it reads Vault secrets.
revoke all on function public.sweep_unsent_reports() from public, anon, authenticated;

-- ── Schedule (every 5 minutes), replacing any prior version ───────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-unsent-reports') then
    perform cron.unschedule('reconcile-unsent-reports');
  end if;
end $$;

select cron.schedule(
  'reconcile-unsent-reports',
  '*/5 * * * *',
  $$ select public.sweep_unsent_reports(); $$
);

-- ── ONE-TIME VAULT SEEDING (run manually in the SQL editor; do NOT commit your
-- service-role key). create_secret errors if the name already exists — to
-- change a value later, use vault.update_secret(<id>, '<new value>').
--
--   select vault.create_secret(
--     'https://wwspvjsnkkgdziixbeei.supabase.co', 'project_url',
--     'Base URL for pg_net → Edge Functions');
--   select vault.create_secret(
--     '<YOUR_SERVICE_ROLE_KEY>', 'service_role_key',
--     'Service-role key for internal Edge Function calls from cron');
