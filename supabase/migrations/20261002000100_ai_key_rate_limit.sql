-- Per-key rate limiting for the `mcp` Edge Function.
--
-- We don't control the AI agents that call `mcp`. An agent stuck in a loop (or a
-- leaked key) could call it thousands of times, so every key gets a per-minute
-- and a per-day call count, kept right on its ai_connection_keys row: no extra
-- table, nothing to clean up, and the counts reset themselves as time moves on.
-- The limits themselves live in the mcp function, where they're easy to tune.

alter table public.ai_connection_keys
  add column if not exists minute_start timestamptz,               -- the minute minute_calls counts
  add column if not exists minute_calls int not null default 0,
  add column if not exists day_start    timestamptz,               -- the (UTC) day day_calls counts
  add column if not exists day_calls    int not null default 0;

-- Find a key by its hash and count this call against it, in ONE atomic
-- statement (the row lock makes concurrent calls count correctly). Also stamps
-- last_used_at for Settings. Returns no row for an unknown key.
--
-- A new minute/day starts the count over at 1. Calls that end up rejected for
-- being over the limit still count, so a client that keeps hammering stays
-- limited until the window rolls over.
create or replace function public.ai_key_hit(p_key_hash text)
returns table (user_id uuid, minute_calls int, day_calls int)
language sql
set search_path = ''
as $$
  update public.ai_connection_keys k
  set minute_calls = case when k.minute_start = date_trunc('minute', now())
                          then k.minute_calls + 1 else 1 end,
      minute_start = date_trunc('minute', now()),
      day_calls    = case when k.day_start = date_trunc('day', now())
                          then k.day_calls + 1 else 1 end,
      day_start    = date_trunc('day', now()),
      last_used_at = now()
  where k.key_hash = p_key_hash
  returning k.user_id, k.minute_calls, k.day_calls;
$$;

-- Server-only, like the table itself: only the mcp function (service role)
-- may call it. Never granted to anon/authenticated.
revoke all on function public.ai_key_hit(text) from public, anon, authenticated;
grant execute on function public.ai_key_hit(text) to service_role;
