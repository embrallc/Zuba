import { supabase } from "../utils/supabase";
import { logError } from "./logs";

// Cloud-only helpers for the organizations row. Organizations is not part of the
// SQLite sync set — the client reads org_sk from auth metadata and these read/write
// the cloud row directly. The business time zone lives here so the server-side
// reminder job can read it; only an owner can write it (RLS: auth_uid_owns_org).

export async function getOrgTimezone(orgSk) {
  if (!orgSk) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data?.timezone ?? null;
  } catch (e) {
    logError(e, `db/organizations.getOrgTimezone orgSk=${orgSk}`);
    return null;
  }
}

// Throws on failure so the caller can revert its optimistic UI and surface an
// error. RLS rejects non-owners, which arrives here as a thrown error.
export async function setOrgTimezone(orgSk, timezone) {
  const { error } = await supabase
    .from("organizations")
    .update({ timezone })
    .eq("org_sk", orgSk);
  if (error) throw error;
  return true;
}

// Stripe Connect: the org's connected-account capability flags (server-truth,
// written by the onboarding/webhook EFs) + the owner auto-comms policy toggles.
// Read-only here; capability columns can't be written by the client (column-level
// REVOKE), only the toggles below can.
export async function getOrgPaymentStatus(orgSk) {
  if (!orgSk) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select(
        "stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, auto_send_report, require_payment_first, auto_send_invoice",
      )
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  } catch (e) {
    logError(e, `db/organizations.getOrgPaymentStatus orgSk=${orgSk}`);
    return null;
  }
}

// First-run onboarding flag. True once the org's owner has seen (or dismissed,
// or completed) the "design your form & report" guidance. Reads fail CLOSED —
// on any error we report "seen" so we never nag on a transient hiccup.
export async function getWalkthroughIntroSeen(orgSk) {
  if (!orgSk) return true;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("has_seen_walkthrough_intro")
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data?.has_seen_walkthrough_intro ?? false;
  } catch (e) {
    logError(e, `db/organizations.getWalkthroughIntroSeen orgSk=${orgSk}`);
    return true;
  }
}

// Owner-only (RLS auth_uid_owns_org). One-way flip to true. Throws on failure so
// the caller can decide whether to retry; the card treats a failure as non-fatal.
export async function markWalkthroughIntroSeen(orgSk) {
  if (!orgSk) return false;
  const { error } = await supabase
    .from("organizations")
    .update({ has_seen_walkthrough_intro: true })
    .eq("org_sk", orgSk);
  if (error) throw error;
  return true;
}

// Owner-only (RLS auth_uid_owns_org). Updates one or more of the comms policy
// toggles. Throws on failure (incl. RLS reject) so the caller can revert.
export async function setOrgPaymentPolicy(orgSk, patch) {
  const allowed = ["auto_send_report", "require_payment_first", "auto_send_invoice"];
  const update = {};
  for (const k of allowed) if (k in patch) update[k] = patch[k];
  if (Object.keys(update).length === 0) return true;
  const { error } = await supabase
    .from("organizations")
    .update(update)
    .eq("org_sk", orgSk);
  if (error) throw error;
  return true;
}
