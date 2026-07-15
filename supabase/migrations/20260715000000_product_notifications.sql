-- ─────────────────────────────────────────────────────────────────────────────
-- Product notifications: global broadcast announcements (outages / updates /
-- releases) shown to every signed-in user in Settings → SUPPORT.
--
-- Deliberately standalone + READ-ONLY from the app, so it can never touch or
-- corrupt inspection/org/billing data:
--   • authenticated users may only SELECT active rows (no insert/update/delete
--     policy → the client physically cannot write it),
--   • authoring = inserting a row from the Supabase dashboard (service-role /
--     postgres bypasses RLS). That's the entire "send a message" workflow.
--
-- Same read-only-broadcast spirit as feedback/app_logs are write-only sinks.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.product_notifications (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,                       -- short label for the list row
  body          text not null,                       -- full message (release notes OK)
  category      text not null default 'update'
                  check (category in ('update', 'release', 'outage')),
  published_at  timestamptz not null default now(),  -- "date posted" + sort key
  is_active     boolean not null default true,       -- flip false to retract
  created_at    timestamptz not null default now()
);

-- Newest-first list of the visible (active) rows.
create index if not exists idx_product_notifications_published
  on public.product_notifications (published_at desc)
  where is_active = true;

alter table public.product_notifications enable row level security;

-- Everyone signed in reads active announcements; nobody writes from the app.
drop policy if exists pn_read on public.product_notifications;
create policy pn_read on public.product_notifications
  for select to authenticated using (is_active = true);

-- Lock anon out entirely (Supabase grants anon/authenticated by default);
-- authenticated gets SELECT only. No write grants → dashboard/service-role only.
revoke all on public.product_notifications from anon;
grant select on public.product_notifications to authenticated;
