-- Simplify find_reply_target — cancel-by-text should be dead simple.
--
-- WHY: the prior matcher took the phone, then required the appointment to be a
-- STRICTLY FUTURE CALENDAR DATE in the org's timezone (`(scheduled_at at tz)::date
-- > (now() at tz)::date`). That excluded SAME-DAY appointments — a client who gets
-- the day-before reminder and texts X ON the day of the inspection got "couldn't
-- find an upcoming inspection to cancel," even though the job hadn't happened yet.
-- (Confirmed on a real prod row: appt at 2026-07-23 20:30 America/Chicago, texted
-- the same day -> is_strictly_future=false -> no target.) It also dragged in a
-- users INNER JOIN + org-timezone coalesce that could drop or mis-evaluate rows,
-- and the `known` existence check used a different row set than the target query
-- (a row could be "known" yet never selectable).
--
-- NEW RULE (owner's call): look the inspection up by phone; if it's OPEN and the
-- appointment time is still in the future, cancel it; otherwise do nothing. A
-- cancel is always restorable by the inspector, so a permissive match has no
-- downside. `scheduled_at > now()` is an ABSOLUTE-TIME comparison on timestamptz,
-- so NO timezone conversion is needed — it is correct in every zone and naturally
-- includes today. `known` (does this number match ANY of our inspections) is kept
-- unchanged so a real customer is never mistaken for a spammer by the EF.

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

  -- Is this number one of our customers at all? Drives spam handling in the EF
  -- (a known customer with nothing to cancel is never logged as an unknown sender).
  select exists(
    select 1 from inspections i
     where coalesce(i._deleted, false) = false
       and i.phone is not null
       and right(regexp_replace(i.phone, '\D', '', 'g'), 10) = v_digits
  ) into v_known;

  -- The inspection to cancel: matched by phone, still OPEN, still upcoming.
  -- Absolute-time compare on timestamptz — timezone-independent, includes today.
  -- Soonest upcoming wins (the client's next appointment).
  select i.inspection_sk into v_target
    from inspections i
   where coalesce(i._deleted, false) = false
     and i.phone is not null
     and right(regexp_replace(i.phone, '\D', '', 'g'), 10) = v_digits
     and coalesce(i.status, 'OPEN') = 'OPEN'
     and i.scheduled_at > now()
   order by i.scheduled_at asc
   limit 1;

  return query select v_target, v_known;
end;
$$;

-- Internal only — the inbound reply EF calls this with the service-role key.
revoke all on function public.find_reply_target(text) from public, anon, authenticated;
grant execute on function public.find_reply_target(text) to service_role;
