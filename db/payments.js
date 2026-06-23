import { supabase } from "../utils/supabase";
import { logError } from "./logs";

// Cloud-only reader for payment_requests. Not part of the SQLite sync set — the
// table is a service-role-written Stripe mirror; the RLS SELECT policy scopes
// rows to the creating inspector and their org's owner/admin, so a plain select
// returns exactly what the caller may see. Writes are server-only (EF/webhook).

// Most-recent payment request per inspection, newest first. Used by the
// Payments screen list.
export async function listPayments({ limit = 100 } = {}) {
  try {
    const { data, error } = await supabase
      .from("payment_requests")
      .select(
        "payment_request_sk, inspection_sk, amount_cents, application_fee_cents, currency, status, checkout_url, created_at, paid_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  } catch (e) {
    logError(e, "db/payments.listPayments");
    return [];
  }
}

// The latest payment request for one inspection (or null). Used to show
// status/badge on a single inspection.
export async function getLatestPaymentForInspection(inspectionSk) {
  if (!inspectionSk) return null;
  try {
    const { data, error } = await supabase
      .from("payment_requests")
      .select(
        "payment_request_sk, inspection_sk, amount_cents, currency, status, checkout_url, created_at, paid_at",
      )
      .eq("inspection_sk", inspectionSk)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  } catch (e) {
    logError(e, `db/payments.getLatestPaymentForInspection sk=${inspectionSk}`);
    return null;
  }
}
