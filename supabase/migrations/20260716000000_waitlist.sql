-- waitlist: pre-launch email capture from the marketing site (getzanbi.com).
--
-- Unlike public.feedback (authenticated-only), the sender here is a LOGGED-OUT
-- website visitor, so the anon role must be allowed to INSERT. It is an
-- append-only sink: anon/authenticated may INSERT ONLY — no one but service_role
-- can SELECT/UPDATE/DELETE, so the collected email list can never be scraped
-- through the public PostgREST API. The owner reads it from the dashboard.

create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  source     text,                    -- where the signup came from, e.g. 'landing'
  created_at timestamptz not null default now(),
  constraint waitlist_email_fmt check (
    email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254
  ),
  -- `source` is client-supplied, so a crafted request can't use it to bloat rows.
  constraint waitlist_source_len check (source is null or char_length(source) <= 64)
);

-- Case-insensitive dedupe: a repeat signup hits this unique index and PostgREST
-- returns 409, which the site treats as success (never revealing membership).
create unique index if not exists waitlist_email_unique on public.waitlist (lower(email));
create index if not exists waitlist_created_idx on public.waitlist (created_at desc);

alter table public.waitlist enable row level security;

-- A logged-out visitor (anon) may append an email; the same format guard as the
-- column constraint lives in the policy so a crafted request can't bypass intent.
drop policy if exists waitlist_insert_public on public.waitlist;
create policy waitlist_insert_public on public.waitlist
  for insert to anon, authenticated
  with check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254);

-- Privilege floor (defense in depth vs. any blanket GRANT): INSERT only for the
-- public roles, nothing else; service_role (dashboard / owner) keeps full access.
revoke all on public.waitlist from anon;
revoke all on public.waitlist from authenticated;
grant insert on public.waitlist to anon;
grant insert on public.waitlist to authenticated;
grant all on public.waitlist to service_role;

-- Owner's query path. security_invoker + revoke mirrors the hardened
-- v_feedback_recent / v_audit_recent so the view can't leak rows to anon.
create or replace view public.v_waitlist_recent as
  select id, created_at, email, source
  from public.waitlist
  order by created_at desc;

alter view public.v_waitlist_recent set (security_invoker = on);
revoke all on public.v_waitlist_recent from anon, authenticated;
grant select on public.v_waitlist_recent to service_role;
