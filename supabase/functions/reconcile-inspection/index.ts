// reconcile-inspection Edge Function — the idempotent convergence engine for
// the auto-release loop. Safe to call repeatedly; each step is enum-guarded.
//
// Triggers (all converge the same way):
//   - the device, right after marking an inspection complete (user JWT)
//   - the Stripe webhook, after marking it paid (service-role / internal)
//   - the pg_cron safety sweep (service-role / internal)
//
// Logic (only for CLOSED inspections):
//   1. First sighting → snapshot the org's policy toggles onto the inspection
//      (freezes behavior at completion time).
//   2. auto_send_report off  → nothing to do (manual send still works).
//   3. require_payment_first && !paid → hold the report ('held').
//   4. otherwise → atomically CLAIM report_state='sending' (only from
//      pending/held/failed, so concurrent runs can't double-send), call
//      send-report-to-client, then set 'sent' or 'failed'.
//
// Auth: service-role bearer = internal; a user JWT must share the inspection's
// org. Bumps _version on every write so synced devices pull the new state.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { logCloudEvent } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[reconcile-inspection]";
const SOURCE = "ef:reconcile-inspection";

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
function logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error: err instanceof Error ? err.message : (anyErr?.message ?? String(err)),
    }),
  );
}

// Read the row's current _version and write a patch with _version+1 so synced
// devices pull the change.
async function bumpedUpdate(
  admin: SupabaseClient,
  inspectionSk: string,
  patch: Record<string, unknown>,
) {
  const { data: cur } = await admin
    .from("inspections")
    .select("_version")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  const nextVersion = Number(cur?._version ?? 1) + 1;
  return admin
    .from("inspections")
    .update({ ...patch, _version: nextVersion, _last_changed_at: Date.now() })
    .eq("inspection_sk", inspectionSk);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const internal = jwt === serviceKey;

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Non-internal callers must be authenticated.
  let callerId: string | null = null;
  if (!internal) {
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "unauthorized" }, 401);
    callerId = user.id;
  }

  let body: { inspectionSk?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const inspectionSk = body.inspectionSk;
  if (!inspectionSk) return json({ error: "missing_inspection" }, 400);

  const { data: insp, error: inspErr } = await admin
    .from("inspections")
    .select(
      "inspection_sk, user_id, status, payment_state, report_state, paid, " +
        "policy_auto_send_report, policy_require_payment_first, policy_auto_send_invoice, _version",
    )
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (inspErr) {
    logError("inspection_lookup_failed", inspErr, { inspectionSk });
    return json({ error: "db_error" }, 500);
  }
  if (!insp) return json({ error: "inspection_not_found" }, 404);

  // Resolve the inspection owner's org (also the auth check for user callers).
  const { data: owner } = await admin
    .from("users")
    .select("org_sk")
    .eq("id", insp.user_id)
    .maybeSingle();
  const orgSk = owner?.org_sk ?? null;
  if (!internal) {
    const { data: caller } = await admin
      .from("users")
      .select("org_sk")
      .eq("id", callerId)
      .maybeSingle();
    if (!caller?.org_sk || !orgSk || caller.org_sk !== orgSk) {
      return json({ error: "forbidden" }, 403);
    }
  }

  // Only completed inspections are part of the loop.
  if ((insp.status ?? "OPEN") !== "CLOSED") {
    logInfo("skip_not_closed", { inspectionSk, status: insp.status });
    return json({ ok: true, skipped: "not_closed", reportState: insp.report_state });
  }

  // 1. Policy snapshot on first sighting — freeze the org's toggles.
  let pSend = insp.policy_auto_send_report;
  let pGate = insp.policy_require_payment_first;
  let pInvoice = insp.policy_auto_send_invoice;
  if (pSend === null || pSend === undefined) {
    let auto = false,
      gate = false,
      inv = false;
    if (orgSk) {
      const { data: org } = await admin
        .from("organizations")
        .select("auto_send_report, require_payment_first, auto_send_invoice")
        .eq("org_sk", orgSk)
        .maybeSingle();
      auto = !!org?.auto_send_report;
      gate = !!org?.require_payment_first;
      inv = !!org?.auto_send_invoice;
    }
    pSend = auto;
    pGate = gate;
    pInvoice = inv;
    await bumpedUpdate(admin, inspectionSk, {
      policy_auto_send_report: auto,
      policy_require_payment_first: gate,
      policy_auto_send_invoice: inv,
    });
    logInfo("policy_snapshot", { inspectionSk, auto, gate, inv });
  }

  // 2. auto-send off → manual path; nothing to converge. (Reads the FROZEN
  // snapshot, not the live org toggle — turning auto-send on after completion
  // does not retroactively send.)
  if (!pSend) {
    logInfo("skip_auto_send_off", {
      inspectionSk,
      policyAutoSendReport: pSend,
      reportState: insp.report_state,
    });
    // Only emit the "skipped" telemetry once — when the report is still pending
    // (i.e. this is the completion-time decision), not on every idempotent re-run.
    if ((insp.report_state ?? "pending") === "pending") {
      void logCloudEvent(admin, SOURCE, "autosend.skipped", {
        data: { inspectionSk, reason: "auto_send_off" },
        userId: insp.user_id,
        orgSk,
      });
    }
    return json({ ok: true, reportState: insp.report_state, reason: "auto_send_off" });
  }

  const paid = insp.paid === true;
  const gateOk = !pGate || paid;

  // 3. Gate not satisfied → hold the report until payment clears.
  if (!gateOk) {
    if (insp.report_state === "pending" || insp.report_state === "failed") {
      await bumpedUpdate(admin, inspectionSk, { report_state: "held" });
      void logCloudEvent(admin, SOURCE, "autosend.held", {
        data: { inspectionSk, reason: "awaiting_payment" },
        userId: insp.user_id,
        orgSk,
      });
    }
    logInfo("hold_awaiting_payment", {
      inspectionSk,
      policyRequirePaymentFirst: pGate,
      paid,
    });
    return json({ ok: true, reportState: "held", reason: "awaiting_payment" });
  }

  // 4. Should send. Atomically claim from a terminal-eligible state so only one
  // concurrent run actually sends.
  const { data: cur } = await admin
    .from("inspections")
    .select("_version")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  const claimVersion = Number(cur?._version ?? 1) + 1;
  const { data: claimed, error: claimErr } = await admin
    .from("inspections")
    .update({
      report_state: "sending",
      _version: claimVersion,
      _last_changed_at: Date.now(),
    })
    .eq("inspection_sk", inspectionSk)
    .in("report_state", ["pending", "held", "failed"])
    .select("inspection_sk");
  if (claimErr) {
    logError("claim_failed", claimErr, { inspectionSk });
    return json({ error: "db_error" }, 500);
  }
  if (!claimed || claimed.length === 0) {
    // Already sending or sent — nothing to do.
    logInfo("skip_already", { inspectionSk, reportState: insp.report_state });
    return json({ ok: true, reportState: insp.report_state, skipped: "already" });
  }

  logInfo("claimed_sending", { inspectionSk });

  // Render (if needed) + email via the internal send EF.
  let success = false;
  let detail: string | undefined;
  try {
    const res = await fetch(`${url}/functions/v1/send-report-to-client`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inspectionSk }),
    });
    const data = await res.json().catch(() => ({}));
    success = res.ok && data?.ok === true;
    if (!success) detail = data?.error ?? `status ${res.status}`;
  } catch (e) {
    detail = (e as Error)?.message;
    logError("send_threw", e, { inspectionSk });
  }

  await bumpedUpdate(admin, inspectionSk, {
    report_state: success ? "sent" : "failed",
  });
  logInfo("converged", { inspectionSk, sent: success, detail });
  // Authoritative auto-send outcome (single source of truth — send-report-to-
  // client doesn't emit its own; its failure reason flows up here as `detail`).
  void logCloudEvent(
    admin,
    SOURCE,
    success ? "autosend.sent" : "autosend.failed",
    {
      data: { inspectionSk, ...(success ? {} : { detail: detail ?? null }) },
      userId: insp.user_id,
      orgSk,
    },
  );
  return json({ ok: true, reportState: success ? "sent" : "failed", detail });
});
