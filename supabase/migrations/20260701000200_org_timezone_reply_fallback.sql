-- Org timezone: stop silently dropping reminders/replies when timezone is NULL.
--
-- Orgs are created (handle_new_user trigger) with no timezone, and the column has
-- no default, so a brand-new org sits at NULL until the owner explicitly sets it.
-- Both the reminder sweep and this reply matcher filtered `timezone IS NULL`, so
-- such an org was skipped entirely — no day-before texts, and inbound X/C replies
-- couldn't match a target.
--
-- Fix (paired with: the settings card now persists the owner's detected device
-- zone on first load, and send-appt-reminders now falls back to Central): here we
-- CREATE OR REPLACE find_reply_target to COALESCE a null org timezone to
-- 'America/Chicago' instead of excluding the row. Deliberately NO backfill / NO
-- column default — leaving the row NULL lets the client heal it to the owner's
-- ACTUAL device zone; this fallback only covers the window before that happens.

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
     and (i.scheduled_at at time zone coalesce(o.timezone, 'America/Chicago'))::date
       > (now() at time zone coalesce(o.timezone, 'America/Chicago'))::date
   order by i.scheduled_at asc
   limit 1;

  return query select v_target, v_known;
end;
$$;

revoke all on function public.find_reply_target(text) from public, anon, authenticated;
grant execute on function public.find_reply_target(text) to service_role;
