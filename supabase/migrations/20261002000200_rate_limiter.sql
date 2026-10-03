-- Reusable rate limiting for Edge Functions.
--
-- public.rate_limits is the SOURCE OF TRUTH for every limit: one row per
-- "scope" (a named thing being limited, e.g. 'mcp'). Change a limit with plain
-- SQL in the Supabase dashboard — it applies on the very next call, no deploy:
--   update public.rate_limits set per_minute = 60 where scope = 'mcp';
--
-- public.rate_limit_counters keeps one row per (scope, subject) — the subject is
-- whoever is being counted, e.g. a user id — with this minute's and today's
-- (UTC) call counts. Counts restart on their own when the minute/day rolls
-- over, so the table never grows beyond one row per subject.
--
-- Edge Functions use it through _shared/rateLimiter.ts (the RateLimiter class),
-- which calls rate_limit_hit() once per request.
--
-- This replaces the MCP-only counters that lived on ai_connection_keys
-- (migration 20261002000100); those columns and ai_key_hit() are dropped below.

create table if not exists public.rate_limits (
  scope       text primary key,
  per_minute  int not null check (per_minute > 0),
  per_day     int not null check (per_day > 0),
  description text,
  updated_at  timestamptz not null default now()
);

comment on table public.rate_limits is
  'Rate limit source of truth: one row per scope. Edit per_minute / per_day here; takes effect on the next call.';

insert into public.rate_limits (scope, per_minute, per_day, description) values
  ('mcp', 30, 1000, 'AI assistant calls to the mcp Edge Function, per user (connection key).')
on conflict (scope) do nothing;

create table if not exists public.rate_limit_counters (
  scope        text not null references public.rate_limits (scope) on delete cascade,
  subject      text not null,          -- who is counted, e.g. a user id
  minute_start timestamptz not null,   -- the minute minute_calls counts
  minute_calls int not null default 0,
  day_start    timestamptz not null,   -- the (UTC) day day_calls counts
  day_calls    int not null default 0,
  primary key (scope, subject)
);

-- Server-only, like the AI key table: RLS on with no policies, nothing for the
-- app's roles. Only Edge Functions (service role) read or change limits.
alter table public.rate_limits enable row level security;
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limits, public.rate_limit_counters from anon, authenticated;
grant all on public.rate_limits, public.rate_limit_counters to service_role;

-- Count one call for (scope, subject) and say whether it's allowed — in ONE
-- atomic statement, so many simultaneous calls still count exactly.
--
--   allowed             true while both counts are within the scope's limits
--   limit_hit           'minute' | 'day' when over (day wins: the longer wait)
--   retry_after_seconds seconds until the limit that was hit resets
--
-- Calls rejected for being over the limit still count, so a client that keeps
-- hammering stays limited until the window rolls over. An unknown scope is an
-- error, so a typo can't quietly switch limiting off.
create or replace function public.rate_limit_hit(p_scope text, p_subject text)
returns table (
  allowed             boolean,
  limit_hit           text,
  minute_calls        int,
  day_calls           int,
  per_minute          int,
  per_day             int,
  retry_after_seconds int
)
language plpgsql
set search_path = ''
as $$
declare
  v_limits public.rate_limits%rowtype;
  v_minute int;
  v_day    int;
  v_hit    text;
begin
  select * into v_limits from public.rate_limits r where r.scope = p_scope;
  if not found then
    raise exception 'rate_limit_hit: no rate_limits row for scope "%"', p_scope;
  end if;

  insert into public.rate_limit_counters as c
    (scope, subject, minute_start, minute_calls, day_start, day_calls)
  values
    (p_scope, p_subject, date_trunc('minute', now()), 1, date_trunc('day', now()), 1)
  on conflict (scope, subject) do update
    set minute_calls = case when c.minute_start = date_trunc('minute', now())
                            then c.minute_calls + 1 else 1 end,
        minute_start = date_trunc('minute', now()),
        day_calls    = case when c.day_start = date_trunc('day', now())
                            then c.day_calls + 1 else 1 end,
        day_start    = date_trunc('day', now())
  returning c.minute_calls, c.day_calls into v_minute, v_day;

  v_hit := case
    when v_day > v_limits.per_day then 'day'
    when v_minute > v_limits.per_minute then 'minute'
  end;

  return query select
    v_hit is null,
    v_hit,
    v_minute,
    v_day,
    v_limits.per_minute,
    v_limits.per_day,
    case v_hit
      when 'day' then ceil(extract(epoch from
        date_trunc('day', now()) + interval '1 day' - now()))::int
      when 'minute' then ceil(extract(epoch from
        date_trunc('minute', now()) + interval '1 minute' - now()))::int
    end;
end;
$$;

revoke all on function public.rate_limit_hit(text, text) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text) to service_role;

-- Retire the MCP-only counters from 20261002000100. The mcp function now finds
-- the key with a plain update (stamping last_used_at) and counts calls through
-- rate_limit_hit('mcp', <user id>).
drop function if exists public.ai_key_hit(text);
alter table public.ai_connection_keys
  drop column if exists minute_start,
  drop column if exists minute_calls,
  drop column if exists day_start,
  drop column if exists day_calls;
