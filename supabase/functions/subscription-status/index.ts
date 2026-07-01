// Subscription-status Edge Function — the single server-side authority on
// whether a user may use the app. The client NEVER computes trial state from
// its own clock; it asks here and routes to the lock screen on anything
// other than "active" / "trial".
//
// POST body (all optional):
//   { deviceAnchor?: string,   // keychain UUID — one-trial-per-device guard
//     sync?: boolean }         // owner just purchased: pull RevenueCat REST
//                              // truth NOW instead of waiting for the webhook
//
// Response:
//   { state: "active" | "trial" | "expired" | "seat_locked",
//     role, daysLeft, seats, members, seatsExceeded,
//     trialEndsAt, periodEndsAt, productId }
//
// State decision order (first match wins):
//   1. comp org or DEV_BYPASS_EMAILS         → active
//   2. entitlement active   → caller inside seat allowance ? active
//                                                          : seat_locked
//   3. now < trial_ends_at                   → trial
//   4.                                       → expired
//
// Trial anchoring: trial_ends_at = organizations.created_at + 30 days,
// materialized into org_billing on first call. The device anchor (hashed)
// is consumed by org owners; a second org checked from a device that already
// consumed a trial starts expired. Anchors are opaque UUIDs minted by the
// app and stored in the iOS keychain, so they survive uninstall/reinstall.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { fetchRcSubscriber, writeOrgBilling } from "../_shared/rcSync.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[subscription-status]";
const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(`${TAG} ${event}`, JSON.stringify(fields));
}

function logError(
  event: string,
  err: unknown,
  fields: Record<string, unknown> = {},
) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error:
        err instanceof Error
          ? err.message
          : ((anyErr?.message as string | undefined) ?? String(err)),
      code: anyErr?.code,
      details: anyErr?.details,
    }),
  );
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let body: { deviceAnchor?: string; sync?: boolean } = {};
  try {
    body = await req.json();
  } catch (_e) {
    // empty body is fine
  }

  // ── Load caller + org ──────────────────────────────────────────────────────
  const { data: me, error: meError } = await admin
    .from("users")
    .select("id, user_profile, org_sk, created_at")
    .eq("id", user.id)
    .single();
  if (meError || !me?.org_sk) {
    logError("user_lookup_failed", meError ?? new Error("no org_sk"), {
      user_id: user.id,
    });
    return json({ error: "User record not found" }, 404);
  }
  const orgSk: string = me.org_sk;
  const role: string = me.user_profile ?? "member";

  // ── Dev bypass (comma-separated emails in a function secret) ──────────────
  const bypassRaw = Deno.env.get("DEV_BYPASS_EMAILS") ?? "";
  const bypass = bypassRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (user.email && bypass.includes(user.email.toLowerCase())) {
    logInfo("dev_bypass", { user_id: user.id });
    return json({
      state: "active",
      role,
      daysLeft: null,
      seats: 9999,
      members: 0,
      seatsExceeded: false,
      trialEndsAt: null,
      periodEndsAt: null,
      productId: null,
    });
  }

  // ── Owner just purchased: pull RevenueCat truth before deciding ───────────
  if (body.sync === true && role === "owner") {
    const rc = await fetchRcSubscriber(user.id);
    if (rc) {
      const wrote = await writeOrgBilling(admin, orgSk, user.id, rc, Date.now());
      logInfo("rest_sync", { org_sk: orgSk, ok: wrote.ok, active: rc.entitlementActive });
    } else {
      logInfo("rest_sync_unavailable", { org_sk: orgSk });
    }
  }

  // ── Load / lazily create org_billing ───────────────────────────────────────
  let { data: billing, error: billErr } = await admin
    .from("org_billing")
    .select("*")
    .eq("org_sk", orgSk)
    .maybeSingle();
  if (billErr) {
    logError("billing_read_failed", billErr, { org_sk: orgSk });
    return json({ error: billErr.message }, 500);
  }

  if (!billing || !billing.trial_ends_at) {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("created_at")
      .eq("org_sk", orgSk)
      .single();
    if (orgErr || !org) {
      logError("org_lookup_failed", orgErr ?? new Error("no org"), {
        org_sk: orgSk,
      });
      return json({ error: "Organization not found" }, 404);
    }
    const trialEnds = new Date(
      new Date(org.created_at).getTime() + TRIAL_DAYS * DAY_MS,
    ).toISOString();
    const { data: upserted, error: upErr } = await admin
      .from("org_billing")
      .upsert({ org_sk: orgSk, trial_ends_at: trialEnds })
      .select("*")
      .single();
    if (upErr || !upserted) {
      logError("billing_init_failed", upErr ?? new Error("no row"), {
        org_sk: orgSk,
      });
      return json({ error: "Could not initialize billing" }, 500);
    }
    billing = upserted;
    logInfo("billing_initialized", { org_sk: orgSk, trial_ends_at: trialEnds });
  }

  // ── One-trial-per-device anchor (owners only) ──────────────────────────────
  if (role === "owner" && typeof body.deviceAnchor === "string" && body.deviceAnchor) {
    try {
      const anchorHash = await sha256Hex(body.deviceAnchor);
      const { data: anchor } = await admin
        .from("trial_devices")
        .select("org_sk")
        .eq("anchor_hash", anchorHash)
        .maybeSingle();
      if (!anchor) {
        await admin
          .from("trial_devices")
          .insert({ anchor_hash: anchorHash, org_sk: orgSk });
      } else if (anchor.org_sk !== orgSk) {
        // This device already burned its trial on a different org.
        const trialEndMs = Date.parse(billing.trial_ends_at);
        if (Number.isFinite(trialEndMs) && trialEndMs > Date.now()) {
          const now = new Date().toISOString();
          await admin
            .from("org_billing")
            .update({ trial_ends_at: now, updated_at: now })
            .eq("org_sk", orgSk);
          billing.trial_ends_at = now;
          logInfo("trial_revoked_device_reuse", { org_sk: orgSk });
        }
      }
    } catch (e) {
      // Anchor handling must never block a legitimate user.
      logError("anchor_check_failed", e, { org_sk: orgSk });
    }
  }

  // ── Decide state ───────────────────────────────────────────────────────────
  const nowMs = Date.now();
  const periodEndMs = billing.period_ends_at
    ? Date.parse(billing.period_ends_at)
    : 0;
  const entitled =
    billing.comp === true ||
    (billing.entitlement_active === true &&
      Number.isFinite(periodEndMs) &&
      periodEndMs > nowMs);
  const seats = billing.comp === true ? 9999 : (billing.seats ?? 0);

  // Seat occupancy: owners first, then by account age. Compare timestamps as
  // instants — Postgres serializes "+00:00", JS writes "Z".
  const { data: orgUsers, error: usersErr } = await admin
    .from("users")
    .select("id, user_profile, created_at")
    .eq("org_sk", orgSk);
  if (usersErr || !orgUsers) {
    logError("org_users_failed", usersErr ?? new Error("no rows"), {
      org_sk: orgSk,
    });
    return json({ error: "Could not load organization members" }, 500);
  }
  const ranked = [...orgUsers].sort((a, b) => {
    const aOwner = a.user_profile === "owner" ? 0 : 1;
    const bOwner = b.user_profile === "owner" ? 0 : 1;
    if (aOwner !== bOwner) return aOwner - bOwner;
    return (
      (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)
    );
  });
  const myRank = ranked.findIndex((u) => u.id === user.id);
  const members = ranked.length;
  const seatsExceeded = entitled && members > seats;

  let state: string;
  if (entitled) {
    state = myRank >= 0 && myRank < seats ? "active" : "seat_locked";
  } else {
    const trialEndMs = Date.parse(billing.trial_ends_at);
    state =
      Number.isFinite(trialEndMs) && trialEndMs > nowMs ? "trial" : "expired";
  }

  const trialEndMs = Date.parse(billing.trial_ends_at);
  const daysLeft =
    state === "trial"
      ? Math.max(0, Math.ceil((trialEndMs - nowMs) / DAY_MS))
      : null;

  logInfo("status", {
    user_id: user.id,
    org_sk: orgSk,
    state,
    role,
    members,
    seats,
    seatsExceeded,
  });

  return json({
    state,
    role,
    daysLeft,
    seats,
    members,
    seatsExceeded,
    trialEndsAt: billing.trial_ends_at,
    periodEndsAt: billing.period_ends_at,
    productId: billing.product_id,
  });
});
