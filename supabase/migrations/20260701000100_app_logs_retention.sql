-- Nightly retention for app_logs — keep 60 days, prune the rest.
--
-- Mirrors the thin pg_cron pattern used by the appt-reminder sweep
-- (20260629000100): a SECURITY DEFINER function does the delete, scheduled once
-- a day. Unlike the reminder cron this calls nothing external, so it needs NO
-- Vault secrets — it just deletes old rows in-database.

create extension if not exists pg_cron;

create or replace function public.prune_app_logs()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.app_logs
   where created_at < now() - interval '60 days';
end;
$$;

-- Only the scheduler (postgres) runs this.
revoke all on function public.prune_app_logs() from public, anon, authenticated;

-- 03:30 UTC daily, replacing any prior version.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-app-logs') then
    perform cron.unschedule('prune-app-logs');
  end if;
end $$;

select cron.schedule(
  'prune-app-logs',
  '30 3 * * *',
  $$ select public.prune_app_logs(); $$
);
