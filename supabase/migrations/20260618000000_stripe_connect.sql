-- Stripe Connect — Phase 0 schema (additive, backward-compatible).
--
-- Adds: org connected-account fields + owner auto-comms policy toggles; the
-- payment_requests Stripe-mirror table; per-inspection payment/report rollup
-- state + multi-recipient report-email array + policy-snapshot columns.
--
-- The pg_cron/pg_net reconcile sweep lands in Phase 3 (not here), so this stays
-- a clean additive migration.

-- ── organizations: connected account (server-truth) + owner policy toggles ────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_account_id          TEXT,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_send_report           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_payment_first      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_send_invoice          BOOLEAN NOT NULL DEFAULT false;

-- The four stripe_* capability columns are server-truth (written by the webhook /
-- status EF via service role). The owner may SELECT them (to drive UI) and may
-- UPDATE the policy toggles, but must NOT write the capability flags. Column-level
-- REVOKE downgrades the broad table UPDATE grant to the remaining columns.
-- service_role / postgres are unaffected.
REVOKE UPDATE (
  stripe_account_id,
  stripe_charges_enabled,
  stripe_payouts_enabled,
  stripe_details_submitted
) ON public.organizations FROM authenticated;

-- ── payment_requests: thin mirror of Stripe Checkout state ────────────────────
-- We are NOT the invoicing system — Stripe hosts checkout and is the source of
-- truth. This table just points at the Stripe session and mirrors its status,
-- flipped to 'paid' only by the webhook.
CREATE TABLE IF NOT EXISTS public.payment_requests (
  payment_request_sk       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_sk            TEXT NOT NULL REFERENCES public.inspections(inspection_sk) ON DELETE CASCADE,
  org_sk                   UUID NOT NULL REFERENCES public.organizations(org_sk),
  created_by               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  stripe_session_id        TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  checkout_url             TEXT,
  amount_cents             INTEGER NOT NULL,
  application_fee_cents    INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  status                   TEXT NOT NULL DEFAULT 'created'
                             CHECK (status IN ('created','open','paid','expired','canceled','refunded')),
  last_event_ms            BIGINT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_inspection ON public.payment_requests(inspection_sk);
CREATE INDEX IF NOT EXISTS idx_payment_requests_org        ON public.payment_requests(org_sk);

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

-- Read: the creating inspector, or an owner/admin of their org (lets the device
-- read "Paid?" directly). No INSERT/UPDATE/DELETE policy — all writes are
-- service-role (create-checkout EF + webhook).
DROP POLICY IF EXISTS "payment_requests_select" ON public.payment_requests;
CREATE POLICY "payment_requests_select"
  ON public.payment_requests FOR SELECT
  USING (auth.uid() = created_by OR public.auth_uid_can_view_org_of(created_by));

-- Defense-in-depth: strip the default write grants (RLS already blocks them).
REVOKE INSERT, UPDATE, DELETE ON public.payment_requests FROM anon, authenticated;

-- ── inspections: payment/report rollup state, recipients, policy snapshot ─────
ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS payment_state               TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS report_state                TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS paid                        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS report_recipients           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS policy_auto_send_report     BOOLEAN,
  ADD COLUMN IF NOT EXISTS policy_require_payment_first BOOLEAN,
  ADD COLUMN IF NOT EXISTS policy_auto_send_invoice    BOOLEAN;

-- Guarded CHECK constraints (idempotent — same pattern as the appt-reminder migration).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_payment_state_check'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_payment_state_check
      CHECK (payment_state IN ('none','requested','paid'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_report_state_check'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_report_state_check
      CHECK (report_state IN ('pending','held','sending','sent','failed'));
  END IF;
END $$;
