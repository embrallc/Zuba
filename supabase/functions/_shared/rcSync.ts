// Shared RevenueCat → org_billing sync, used by both the revenuecat-webhook
// edge function (push) and subscription-status (on-demand pull right after a
// purchase, before the webhook lands).
//
// Strategy: webhooks are treated as a "something changed" signal, not as the
// source of truth. Whenever possible we re-fetch the subscriber from the
// RevenueCat REST API and mirror that into org_billing — this sidesteps every
// event-ordering / PRODUCT_CHANGE / grace-period subtlety because we always
// write the current state, never a delta.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };

export const ENTITLEMENT_ID = "Embra LLC Pro";

// Product IDs encode the seat count: kensa_pro_seats_1, kensa_pro_seats_3...
// An active entitlement whose product doesn't match falls back to 1 seat.
export function seatsFromProductId(productId: string | null | undefined) {
  if (!productId) return 1;
  const m = /seats?[_-]?(\d+)/i.exec(productId);
  const n = m ? parseInt(m[1], 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export type RcState = {
  entitlementActive: boolean;
  productId: string | null;
  periodEndsAt: string | null; // ISO
  seats: number;
};

// Pull the subscriber from RevenueCat's REST API. Returns null when the
// secret key isn't configured or the request fails — callers fall back to
// whatever org_billing already holds.
export async function fetchRcSubscriber(
  appUserId: string,
): Promise<RcState | null> {
  const apiKey = Deno.env.get("REVENUECAT_SECRET_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return null;
    const body = await res.json();
    const ent = body?.subscriber?.entitlements?.[ENTITLEMENT_ID];
    if (!ent) {
      return {
        entitlementActive: false,
        productId: null,
        periodEndsAt: null,
        seats: 0,
      };
    }
    const expiresMs = ent.expires_date ? Date.parse(ent.expires_date) : 0;
    const active = Number.isFinite(expiresMs) && expiresMs > Date.now();
    const productId = ent.product_identifier ?? null;
    return {
      entitlementActive: active,
      productId,
      periodEndsAt: ent.expires_date ?? null,
      seats: active ? seatsFromProductId(productId) : 0,
    };
  } catch (_e) {
    return null;
  }
}

// Mirror an RcState into org_billing for the given org. eventMs guards
// against out-of-order webhook deliveries (REST pulls pass Date.now()).
export async function writeOrgBilling(
  admin: SupabaseClient,
  orgSk: string,
  rcAppUserId: string,
  state: RcState,
  eventMs: number,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const { data: existing, error: readErr } = await admin
    .from("org_billing")
    .select("last_event_ms")
    .eq("org_sk", orgSk)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (existing && Number(existing.last_event_ms) > eventMs) {
    return { ok: true, skipped: true };
  }
  const { error: upsertErr } = await admin.from("org_billing").upsert({
    org_sk: orgSk,
    entitlement_active: state.entitlementActive,
    seats: state.seats,
    product_id: state.productId,
    period_ends_at: state.periodEndsAt,
    rc_app_user_id: rcAppUserId,
    last_event_ms: eventMs,
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) return { ok: false, error: upsertErr.message };
  return { ok: true };
}
