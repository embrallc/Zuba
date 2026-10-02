-- AI connection keys ("Integrate your favorite AI").
--
-- A user can generate ONE key that lets an AI assistant (Muse, ChatGPT, Claude,
-- a skill or script on their computer...) call the `mcp` Edge Function as them.
-- The key only works at that endpoint: the function hashes the presented key,
-- looks the hash up here, and runs its tools for the matching user.
--
-- Only the SHA-256 hash is stored. The key itself is returned to the user once,
-- at creation, and never saved anywhere. Losing it means disable + create again.
--
-- Empty until a user turns it on; "Disable my AI Connection" deletes the row.

create table if not exists public.ai_connection_keys (
  -- One key per user: the primary key makes that a database rule, so a second
  -- create (double tap, two devices) fails here even if the function's own
  -- "already have one?" check is raced.
  user_id      uuid primary key references public.users (id) on delete cascade,
  key_hash     text not null unique,   -- unique = the lookup index the MCP endpoint uses
  key_prefix   text not null,          -- first characters (e.g. "zanbi_ai_1a2b"), shown in Settings
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table public.ai_connection_keys is
  'One AI connection key per user (SHA-256 hash only). Service-role only: the app reads/writes through the ai-connection Edge Function, the mcp Edge Function checks keys.';

-- Server-only, same posture as the Drive tables: RLS on with no policies, nothing
-- granted to the app's roles. The app never reads this table directly.
alter table public.ai_connection_keys enable row level security;
revoke all on public.ai_connection_keys from anon, authenticated;
grant all on public.ai_connection_keys to service_role;
