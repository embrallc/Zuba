// appt-reminder-reply Edge Function — inbound Twilio webhook for C/X replies.
//
// MUST be deployed with verify_jwt = false (Twilio holds no Supabase JWT).
// Authentication is the Twilio request signature (X-Twilio-Signature, HMAC-SHA1
// of the URL + sorted params, keyed by the auth token) — this blocks forged
// POSTs to the function URL. It does NOT stop a real person texting your real
// number, so abuse handling is separate (below).
//
// Flow (after signature verify + normalize the From number):
//   1. Already-blocked unknown number → drop immediately, no work, no reply.
//   2. find_reply_target(From): customer match? + the soonest upcoming-not-today
//      (org-local) inspection to act on.
//   3. Not a customer → log to sms_unknown_senders (atomic increment, auto-block
//      past 5), send NO reply (so junk costs only the inbound segment).
//   4. Customer: "X" → cancel that inspection (status=CANCELLED, bump sync
//      fields → Realtime carries it live to the inspector). "C" → no-op.
//   5. Auto-reply via TwiML unless TWILIO_AUTO_REPLY="false".
//
// All secrets (TWILIO_AUTH_TOKEN, service-role key) come from EF env only.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { logCloudEvent } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[appt-reminder-reply]";
const SOURCE = "ef:appt-reminder-reply";

const REPLY_CANCELLED = "Your inspection has been cancelled.";
const REPLY_CONFIRMED = "Thanks! See you then.";
const REPLY_NO_TARGET =
  "We couldn't find an upcoming inspection to cancel — please call your inspector.";

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

function xmlEscape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function twiml(message?: string) {
  const inner = message ? `<Message>${xmlEscape(message)}</Message>` : "";
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

// Twilio signature: base64( HMAC-SHA1( url + concat(sorted key+value), authToken ) ).
async function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // length-safe constant-ish comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!authToken) {
    logError("misconfigured", new Error("TWILIO_AUTH_TOKEN not set"));
    return new Response("server_misconfigured", { status: 500 });
  }

  // Read the urlencoded body once; use it for both signature and fields.
  const rawBody = await req.text();
  const form = new URLSearchParams(rawBody);
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = v;

  // URL the signature was computed over must match what Twilio called. Prefer an
  // explicit env (avoids gateway-rewrite mismatches); fall back to reconstruction.
  const envUrl = Deno.env.get("TWILIO_WEBHOOK_URL");
  let signUrl = envUrl ?? "";
  if (!signUrl) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
    const u = new URL(req.url);
    signUrl = `${proto}://${host}${u.pathname}${u.search}`;
  }

  const sig = req.headers.get("x-twilio-signature") ?? "";
  const ok = sig && (await validTwilioSignature(authToken, signUrl, params, sig));
  if (!ok) {
    logError("bad_signature", new Error("signature mismatch"), {
      hasSig: !!sig,
      usedEnvUrl: !!envUrl,
      hint: envUrl ? undefined : "set TWILIO_WEBHOOK_URL to the exact configured webhook URL",
    });
    return new Response("forbidden", { status: 403 });
  }

  const from = params.From ?? "";
  const body = (params.Body ?? "").trim();
  const first = body.charAt(0).toLowerCase();
  const norm = from.replace(/\D/g, "").slice(-10);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const autoReply = Deno.env.get("TWILIO_AUTO_REPLY") !== "false";

  // 1. Already-blocked unknown number → drop with zero work.
  if (norm.length === 10) {
    const { data: blk } = await admin
      .from("sms_unknown_senders")
      .select("blocked")
      .eq("phone", norm)
      .maybeSingle();
    if (blk?.blocked) {
      logInfo("drop_blocked", { norm });
      return twiml();
    }
  }

  // 2. Match against customers.
  const { data: matchRows, error: matchErr } = await admin.rpc("find_reply_target", {
    p_from: from,
  });
  if (matchErr) {
    logError("match_rpc_failed", matchErr, { norm });
    return twiml(); // fail safe: never error back to Twilio
  }
  const match = Array.isArray(matchRows) ? matchRows[0] : matchRows;
  const known = !!match?.known;
  const targetSk: string | null = match?.target_sk ?? null;

  // 3. Not a customer → abuse table, no reply.
  if (!known) {
    if (norm.length === 10) {
      const { data: nowBlocked } = await admin.rpc("bump_unknown_sender", { p_phone: norm });
      logInfo("unknown_sender", { norm, blocked: !!nowBlocked });
    } else {
      logInfo("unknown_short_number", { from });
    }
    return twiml();
  }

  // 4. Known customer → act on C / X.
  if (first === "x") {
    if (targetSk) {
      const { data: cur } = await admin
        .from("inspections")
        .select("_version")
        .eq("inspection_sk", targetSk)
        .maybeSingle();
      const nextVersion = Number(cur?._version ?? 1) + 1;
      const { error: updErr } = await admin
        .from("inspections")
        .update({
          status: "CANCELLED",
          _version: nextVersion,
          _last_changed_at: Date.now(),
        })
        .eq("inspection_sk", targetSk)
        .not("status", "in", "(CANCELLED,CLOSED)");
      if (updErr) {
        logError("cancel_failed", updErr, { targetSk });
        return twiml();
      }
      logInfo("cancelled", { targetSk, norm });
      void logCloudEvent(admin, SOURCE, "reminder.replied", {
        data: { action: "cancel", targetSk },
      });
      return twiml(autoReply ? REPLY_CANCELLED : undefined);
    }
    // Known customer but nothing upcoming-not-today to cancel (e.g. same-day job).
    logInfo("cancel_no_target", { norm });
    return twiml(autoReply ? REPLY_NO_TARGET : undefined);
  }

  if (first === "c") {
    logInfo("confirmed", { norm, targetSk });
    void logCloudEvent(admin, SOURCE, "reminder.replied", {
      data: { action: "confirm", targetSk },
    });
    return twiml(autoReply ? REPLY_CONFIRMED : undefined);
  }

  // Recognized customer, unrecognized keyword → ignore silently (no cost/loops).
  logInfo("ignored_keyword", { norm, body: body.slice(0, 24) });
  return twiml();
});
