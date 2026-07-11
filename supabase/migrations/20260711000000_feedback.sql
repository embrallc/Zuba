-- feedback: user-submitted ideas, feedback, and issue reports from the in-app
-- "Ideas, Feedback, & Issues" screen (Settings). A PRIVATE, APPEND-ONLY sink —
-- the owner triages it via the Supabase dashboard / service role, NOT through
-- the app.
--
-- Deliberately a STANDALONE table (not the `audit` schema): audit tracks
-- machine-generated data-change history; this is human product input. Mixing
-- them would make daily feedback triage wade through audit noise, and vice
-- versa. RLS mirrors app_logs: authenticated users may INSERT their OWN row
-- only (user_id defaults to auth.uid() server-side); no client read;
-- service_role (dashboard) has full access and is the owner's query path.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid() references auth.users(id) on delete set null,
  org_sk      uuid,
  body        text not null,
  category    text,                            -- reserved (freeform); one-box UI sends null for now
  app_version text,
  platform    text,
  status      text not null default 'new',     -- triage: 'new' | 'reviewed' | 'closed'
  created_at  timestamptz not null default now(),
  constraint feedback_body_len check (char_length(body) between 1 and 1000)
);

create index if not exists feedback_created_idx        on public.feedback (created_at desc);
create index if not exists feedback_status_created_idx on public.feedback (status, created_at desc);

alter table public.feedback enable row level security;

-- Device insert path: append your OWN row only (user_id defaults to auth.uid()).
drop policy if exists feedback_insert_own on public.feedback;
create policy feedback_insert_own on public.feedback
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Privilege floor (defense in depth vs. any blanket GRANT ALL): append-only for
-- authenticated, nothing for anon; service_role (dashboard / owner triage) keeps
-- full access.
revoke all on public.feedback from anon;
revoke all on public.feedback from authenticated;
grant insert on public.feedback to authenticated;
grant all on public.feedback to service_role;

-- Convenience view for daily triage (query as service_role in the dashboard).
create or replace view public.v_feedback_recent as
  select id, created_at, status, category, body, app_version, platform, user_id, org_sk
  from public.feedback
  order by created_at desc;

grant select on public.v_feedback_recent to service_role;
