-- Hourly scheduler for day-before appointment reminders.
--
-- The cron job is intentionally thin: every hour it calls the
-- send-appt-reminders Edge Function, which owns ALL the logic (which orgs are at
-- their local 10am, which inspections are due tomorrow, the Twilio send, and the
-- PENDING→SENT flip). Running hourly is what lets a single job cover every
-- timezone — the EF simply no-ops for orgs that aren't in their 10am window.
--
-- Secrets: like the reconcile sweep, this calls the EF over pg_net and needs the
-- project URL + service-role key from Supabase Vault (names 'project_url' /
-- 'service_role_key', already seeded for reconcile-unsent-reports — reused here).
-- The function no-ops with a warning until they exist, so this is safe to apply
-- before seeding.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Trigger function ─────────────────────────────────────────────────────────
create or replace function public.fire_appt_reminders()
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
    raise warning 'fire_appt_reminders: missing vault secrets project_url/service_role_key — skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/send-appt-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := '{}'::jsonb
  );
end;
$$;

-- Only the scheduler (postgres) should run this; it reads Vault secrets.
revoke all on function public.fire_appt_reminders() from public, anon, authenticated;

-- ── Schedule (top of every hour), replacing any prior version ────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-appt-reminders') then
    perform cron.unschedule('send-appt-reminders');
  end if;
end $$;

select cron.schedule(
  'send-appt-reminders',
  '0 * * * *',
  $$ select public.fire_appt_reminders(); $$
);
