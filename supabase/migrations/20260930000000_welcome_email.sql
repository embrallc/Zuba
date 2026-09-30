-- ─────────────────────────────────────────────────────────────────────────────
-- Welcome email for new owners.
--
-- When a new user signs up, send them a one-time welcome via Resend (the
-- send-welcome-email Edge Function). Owners only — the copy is about starting a
-- 30-day trial, and a member joining someone else's org isn't on one.
--
-- Fires at SIGNUP, before email confirmation, on purpose: someone who has
-- trouble verifying is exactly who needs the support contact in this email. The
-- function adds a short "haven't confirmed yet?" paragraph when the user is still
-- unverified at send time (an unverified user can't log in to reach Settings).
-- Abuse surface: a stranger's address can already receive our confirmation email
-- at signup; this adds one more email to that, not a new kind of exposure.
--
-- ⚠️ This is a trigger on auth.users. It must never be able to fail a signup, so
-- the queueing is wrapped in an exception handler, and net.http_post only queues
-- (the HTTP call happens after commit, off the auth path).
--
-- Mirrors the feedback-notify plumbing: a SECURITY DEFINER function reads
-- project_url + service_role_key from Vault and calls the EF over pg_net;
-- warn-and-skip when the Vault secrets are absent.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_net;

-- ── Ledger: who has been welcomed ────────────────────────────────────────────
-- A separate table rather than a column on public.users (which devices sync and
-- users can partly update). The primary key is the idempotency claim: the EF
-- inserts a row before sending, so a double-fire can only ever send once.
create table if not exists public.welcome_emails (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  sent_at     timestamptz not null default now(),
  resend_id   text,                          -- Resend message id when actually sent
  backfilled  boolean not null default false -- true = existed before this feature
);

alter table public.welcome_emails enable row level security;
revoke all on public.welcome_emails from anon, authenticated;
grant all on public.welcome_emails to service_role;

-- Everyone who exists today is marked done, so this only ever reaches people who
-- sign up from here on — no surprise email to current users. (To welcome an
-- existing user anyway, delete their backfilled row and call fire_welcome_email.)
insert into public.welcome_emails (user_id, backfilled)
select id, true from auth.users
on conflict (user_id) do nothing;

-- ── Fire the EF for one user (also callable by hand to re-send) ──────────────
create or replace function public.fire_welcome_email(p_user_id uuid)
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
    raise warning 'fire_welcome_email: missing vault secrets project_url/service_role_key — skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/send-welcome-email',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('userId', p_user_id)
  );
end;
$$;

revoke all on function public.fire_welcome_email(uuid) from public, anon, authenticated;

-- ── Trigger on auth.users (signup) ───────────────────────────────────────────
create or replace function public.trg_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.fire_welcome_email(new.id);
  exception when others then
    -- Never let a welcome email break signup.
    raise warning 'trg_welcome_email: could not queue welcome for % — %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.trg_welcome_email() from public, anon, authenticated;

drop trigger if exists welcome_email_on_signup on auth.users;
create trigger welcome_email_on_signup
  after insert on auth.users
  for each row
  execute function public.trg_welcome_email();
