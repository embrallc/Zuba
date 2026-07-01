// Shared Stripe → Postgres mirror helpers, used by the webhook (and later the
// reconciler). Same philosophy as rcSync.ts: Stripe is the source of truth; we
// only mirror its current state into our thin tables, guarded against
// out-of-order delivery by last_event_ms.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type CheckoutPatch = {
  sessionId: string;
  status: "open" | "paid" | "expired" | "canceled" | "refunded";
  paymentIntentId?: string | null;
  eventMs: number;
  paidAt?: string | null;
};

// Apply a Stripe Checkout/PI status change to the payment_requests mirror.
// Returns the linked inspection_sk so the caller can roll the inspection up.
export async function applyCheckoutStatus(
  admin: SupabaseClient,
  patch: CheckoutPatch,
): Promise<{
  ok: boolean;
  error?: string;
  missing?: boolean;
  skipped?: boolean;
  inspectionSk?: string;
}> {
  const { data: existing, error: readErr } = await admin
    .from("payment_requests")
    .select("inspection_sk, last_event_ms, status")
    .eq("stripe_session_id", patch.sessionId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: true, missing: true };

  const inspectionSk = existing.inspection_sk as string;

  // Out-of-order guard. A 'paid' that already landed must never be downgraded
  // by a late 'expired'/'open'.
  if (Number(existing.last_event_ms) > patch.eventMs) {
    return { ok: true, skipped: true, inspectionSk };
  }
  if (existing.status === "paid" && patch.status !== "refunded") {
    return { ok: true, skipped: true, inspectionSk };
  }

  const update: Record<string, unknown> = {
    status: patch.status,
    last_event_ms: patch.eventMs,
    updated_at: new Date().toISOString(),
  };
  if (patch.paymentIntentId) update.stripe_payment_intent_id = patch.paymentIntentId;
  if (patch.status === "paid") update.paid_at = patch.paidAt ?? new Date().toISOString();

  const { error: upErr } = await admin
    .from("payment_requests")
    .update(update)
    .eq("stripe_session_id", patch.sessionId);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, inspectionSk };
}

// Flip the inspection payment rollup to paid and bump _version so every
// synced device pulls the change (the device never writes these columns — see
// pushInspection's omit list).
export async function markInspectionPaid(
  admin: SupabaseClient,
  inspectionSk: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: insp, error: readErr } = await admin
    .from("inspections")
    .select("_version, paid")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!insp) return { ok: true };
  if (insp.paid === true) return { ok: true }; // already paid — no-op

  const nextVersion = Number(insp._version ?? 1) + 1;
  const { error: upErr } = await admin
    .from("inspections")
    .update({
      paid: true,
      payment_state: "paid",
      _version: nextVersion,
      _last_changed_at: Date.now(),
    })
    .eq("inspection_sk", inspectionSk);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true };
}

// Mirror a connected account's capability flags onto its org row. Driven by the
// account.updated webhook (and the on-demand status EF). Looks the org up by the
// connected account id so no org_sk is needed.
export async function mirrorAccountCapabilities(
  admin: SupabaseClient,
  account: {
    id?: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  },
): Promise<{ ok: boolean; error?: string; missing?: boolean }> {
  const accountId = account?.id;
  if (!accountId) return { ok: true, missing: true };
  const { error } = await admin
    .from("organizations")
    .update({
      stripe_charges_enabled: !!account.charges_enabled,
      stripe_payouts_enabled: !!account.payouts_enabled,
      stripe_details_submitted: !!account.details_submitted,
    })
    .eq("stripe_account_id", accountId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
