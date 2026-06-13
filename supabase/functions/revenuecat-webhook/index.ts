// RevenueCat webhook receiver — keeps org_billing mirroring the store truth.
//
// MUST be deployed with --no-verify-jwt (RevenueCat's servers don't hold a
// Supabase JWT). Authentication instead uses a shared secret: set the same
// value in the RevenueCat dashboard (Webhooks → Authorization header) and in
// the RC_WEBHOOK_SECRET function secret. Requests without it are rejected.
//
// Events are treated as a "something changed" signal: when the
// REVENUECAT_SECRET_API_KEY secret is configured we re-fetch the subscriber
// from RevenueCat's REST API and write current state (immune to event
// ordering, PRODUCT_CHANGE timing, grace periods). Without the key we fall
// back to the event's own fields, guarded by event_timestamp_ms.
//
// Always returns 200 for understood-but-unactionable events (e.g. the payer
// deleted their account) — non-2xx makes RevenueCat retry forever.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchRcSubscriber,
  seatsFromProductId,
  writeOrgBilling,
} from "../_shared/rcSync.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[revenuecat-webhook]";

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
    }),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("RC_WEBHOOK_SECRET");
  if (!secret) {
    logError("misconfigured", new Error("RC_WEBHOOK_SECRET not set"));
    return json({ error: "Server misconfigured" }, 500);
  }
  const auth = req.headers.get("Authorization") ?? "";
  // RevenueCat sends the header value verbatim — accept with or without the
  // conventional "Bearer " prefix.
  if (auth !== secret && auth !== `Bearer ${secret}`) {
    logInfo("rejected.bad_secret");
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch (_e) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const event = (payload?.event ?? {}) as Record<string, unknown>;
  const type = String(event.type ?? "UNKNOWN");
  const appUserId = String(
    event.app_user_id ?? event.original_app_user_id ?? "",
  );
  logInfo("event", { type, app_user_id: appUserId });

  // Anonymous RC users ($RCAnonymousID:...) can't map to an org — we always
  // logIn with the Supabase uid before purchase, so these are pre-login noise.
  if (!appUserId || appUserId.startsWith("$RCAnonymousID")) {
    return json({ ok: true, skipped: "anonymous_user" });
  }

  const admin: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: payer, error: payerErr } = await admin
    .from("users")
    .select("id, org_sk")
    .eq("id", appUserId)
    .maybeSingle();
  if (payerErr) {
    logError("payer_lookup_failed", payerErr, { app_user_id: appUserId });
    return json({ error: payerErr.message }, 500);
  }
  if (!payer?.org_sk) {
    // Payer no longer exists (account deleted) — nothing to update.
    logInfo("skipped.no_payer_org", { app_user_id: appUserId });
    return json({ ok: true, skipped: "no_payer_org" });
  }
  const orgSk: string = payer.org_sk;

  // Preferred path: pull current truth from the REST API.
  const rc = await fetchRcSubscriber(appUserId);
  if (rc) {
    const wrote = await writeOrgBilling(admin, orgSk, appUserId, rc, Date.now());
    if (!wrote.ok) {
      logError("write_failed", new Error(wrote.error ?? "unknown"), {
        org_sk: orgSk,
      });
      return json({ error: wrote.error }, 500);
    }
    logInfo("synced.rest", {
      org_sk: orgSk,
      active: rc.entitlementActive,
      seats: rc.seats,
      product: rc.productId,
    });
    return json({ ok: true });
  }

  // Fallback: derive state from the event itself.
  const expirationMs = Number(event.expiration_at_ms ?? 0);
  const eventMs = Number(event.event_timestamp_ms ?? Date.now());
  const productId = (event.product_id as string | undefined) ?? null;
  const active = Number.isFinite(expirationMs) && expirationMs > Date.now();
  const wrote = await writeOrgBilling(
    admin,
    orgSk,
    appUserId,
    {
      entitlementActive: active,
      productId,
      periodEndsAt: expirationMs ? new Date(expirationMs).toISOString() : null,
      seats: active ? seatsFromProductId(productId) : 0,
    },
    eventMs,
  );
  if (!wrote.ok) {
    logError("write_failed", new Error(wrote.error ?? "unknown"), {
      org_sk: orgSk,
    });
    return json({ error: wrote.error }, 500);
  }
  logInfo("synced.event_fields", {
    org_sk: orgSk,
    type,
    active,
    skipped: wrote.skipped ?? false,
  });
  return json({ ok: true });
});
