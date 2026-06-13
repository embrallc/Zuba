-- Org-level billing state for the RevenueCat subscription system.
--
-- Model: the org OWNER holds one auto-renewable App Store subscription whose
-- product encodes a seat count (e.g. kensa_pro_seats_3). RevenueCat webhooks
-- (and an on-demand REST sync) write the entitlement state here; the
-- subscription-status edge function reads it to decide trial/active/expired
-- per caller. Clients NEVER read or write these tables directly — RLS is
-- enabled with no policies (service-role only), same pattern as route_cache
-- and form_editor_tokens.

create table if not exists public.org_billing (
  org_sk uuid primary key references public.organizations(org_sk) on delete cascade,

  -- Trial. Derived once from organizations.created_at (+30 days) on first
  -- status check; stored so it can be overridden (device-anchor abuse sets it
  -- to the past, a support comp can extend it).
  trial_ends_at timestamptz,

  -- Entitlement mirror, written only by revenuecat-webhook / REST sync.
  entitlement_active boolean not null default false,
  seats integer not null default 0,
  product_id text,
  period_ends_at timestamptz,
  rc_app_user_id text,            -- payer's app_user_id (= supabase auth uid)
  last_event_ms bigint not null default 0,  -- out-of-order webhook guard

  -- Comped orgs (dev / support) bypass all checks.
  comp boolean not null default false,

  updated_at timestamptz not null default now()
);

alter table public.org_billing enable row level security;

-- One free trial per device. anchor_hash is the SHA-256 of a UUID the app
-- mints once and stores in the iOS keychain (survives uninstall/reinstall).
-- Consumed when an org OWNER's device first checks status during a trial;
-- a second org created from the same device starts expired.
create table if not exists public.trial_devices (
  anchor_hash text primary key,
  org_sk uuid,
  created_at timestamptz not null default now()
);

alter table public.trial_devices enable row level security;
