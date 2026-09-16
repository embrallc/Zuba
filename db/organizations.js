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

// The company name shown on client-facing reports (report.orgName binding).
// Read fails soft (returns null); the caller shows a placeholder.
export async function getOrgName(orgSk) {
  if (!orgSk) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("org_name")
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data?.org_name ?? null;
  } catch (e) {
    logError(e, `db/organizations.getOrgName orgSk=${orgSk}`);
    return null;
  }
}

// Owner-only (RLS auth_uid_owns_org; column grant in 20260728000000). Throws on
// failure (incl. RLS reject) so the caller can revert its optimistic UI. The
// write is immediate — reports read org_name fresh from the cloud at generation.
export async function setOrgName(orgSk, name) {
  const { error } = await supabase
    .from("organizations")
    .update({ org_name: name })
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

// Report Types config for this org. `*_enabled` = which report types the org
// produces at all; `*_default` = the default state of a NEW inspection's toggle.
// Read fails soft (returns null) — the caller falls back to "both on" so a
// transient offline read never hides an option. Any org member may read it (org
// SELECT RLS is role-agnostic); only the owner may write (below).
export async function getOrgReportTypes(orgSk) {
  if (!orgSk) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select(
        "report_pdf_enabled, report_online_enabled, report_pdf_default, report_online_default",
      )
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  } catch (e) {
    logError(e, `db/organizations.getOrgReportTypes orgSk=${orgSk}`);
    return null;
  }
}

// Google Drive backup is FORWARD-ONLY — nothing completed before the owner
// connects is archived — so a new owner gets one prompt telling them to set it
// up now. Org-level + one-way, exactly like the walkthrough intro above: shown
// at most once per org, never again once dismissed or already connected. Reads
// fail CLOSED (report "seen") so a transient hiccup can never nag them.
export async function getDrivePromptSeen(orgSk) {
  if (!orgSk) return true;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("has_seen_drive_prompt")
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    return data?.has_seen_drive_prompt ?? false;
  } catch (e) {
    logError(e, `db/organizations.getDrivePromptSeen orgSk=${orgSk}`);
    return true;
  }
}

// Owner-only (RLS auth_uid_owns_org). One-way flip to true.
export async function markDrivePromptSeen(orgSk) {
  if (!orgSk) return false;
  const { error } = await supabase
    .from("organizations")
    .update({ has_seen_drive_prompt: true })
    .eq("org_sk", orgSk);
  if (error) throw error;
  return true;
}

// Owner-only (RLS auth_uid_owns_org). Updates one or more Report Types columns.
// Throws on failure (incl. RLS reject) so the caller can revert its optimistic UI.
export async function setOrgReportTypes(orgSk, patch) {
  const allowed = [
    "report_pdf_enabled",
    "report_online_enabled",
    "report_pdf_default",
    "report_online_default",
  ];
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
