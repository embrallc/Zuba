// resend-report Edge Function (user-invoked "Send report to client").
//
// The device taps "Send" in the report viewer; this picks up the MOST RECENT
// already-generated PDF for the inspection (no re-render — if they want a fresh
// one they hit Generate first), signs a long-TTL link, and emails it to every
// address registered on the REPORT channel via Resend. Cross-platform by design:
// nothing depends on the device's mail app.
//
// It owns NO state — the one-time auto-send gate (report_state) is untouched;
// this is the deliberate, rare manual re-send path. Best-effort event log only.
//
// Auth: a normal user JWT (verify_jwt=true). The inspection must belong to the
// caller. Body: { inspectionSk }. Returns { ok, recipientCount } or { ok:false, error }.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { channelRecipients, sendEmail } from "../_shared/email.ts";
import { logCloudEvent, logToCloud } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[resend-report]";
const SOURCE = "ef:resend-report";
const REPORT_BUCKET = "inspection-reports";
const LINK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — matches auto-send.

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    console.error(`${TAG} missing_env`);
    return json({ ok: false, error: "server_misconfigured" }, 500);
  }

  // 1. Auth — resolve the caller from their JWT (only the inspection's owner may
  // send its report).
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "missing_token" }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: "invalid_token" }, 401);
  const userId = userData.user.id;

  let body: { inspectionSk?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const inspectionSk = body.inspectionSk;
  if (!inspectionSk) return json({ ok: false, error: "missing_inspection" }, 400);

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 2. Load + authorize the inspection.
  const { data: insp, error: inspErr } = await admin
    .from("inspections")
    .select(
      "inspection_sk, user_id, org_sk, full_name, address_line1, city, state, email, report_recipients",
    )
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (inspErr) {
    console.error(`${TAG} inspection_lookup_failed`, inspErr.message);
    return json({ ok: false, error: "db_error" }, 500);
  }
  if (!insp) return json({ ok: false, error: "inspection_not_found" }, 404);
  if (insp.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);

  // 3. Recipients — everyone on the REPORT channel (same selection as auto-send).
  const recipients = channelRecipients(insp.report_recipients, insp.email, "report");
  if (recipients.length === 0) return json({ ok: false, error: "no_recipients" }, 200);

  // 4. Newest already-generated PDF. No re-render: Generate makes a fresh one,
  // Send mails the latest. None yet → tell the app to generate first.
  const { data: latest } = await admin
    .from("inspection_reports")
    .select("storage_path")
    .eq("inspection_sk", inspectionSk)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const storagePath = latest?.storage_path ?? null;
  if (!storagePath) return json({ ok: false, error: "no_report" }, 200);

  // 5. Long-TTL signed link.
  const { data: signed, error: signErr } = await admin.storage
    .from(REPORT_BUCKET)
    .createSignedUrl(storagePath, LINK_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    console.error(`${TAG} sign_failed`, signErr?.message);
    return json({ ok: false, error: "sign_failed" }, 200);
  }
  const link = signed.signedUrl;

  const who = insp.full_name || "there";
  const addr = [insp.address_line1, insp.city, insp.state].filter(Boolean).join(", ");
  const subject = `Your inspection report${addr ? ` — ${addr}` : ""}`;
  const text =
    `Hi ${who},\n\n` +
    `Your inspection report is ready. You can view and download it here:\n${link}\n\n` +
    `This link will stop working after 30 days. Thank you!`;
  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5">` +
    `<p>Hi ${who},</p>` +
    `<p>Your inspection report${addr ? ` for <strong>${addr}</strong>` : ""} is ready.</p>` +
    `<p><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">View your report</a></p>` +
    `<p style="color:#888;font-size:13px">Or paste this link into your browser:<br>${link}</p>` +
    `<p style="color:#888;font-size:13px">This link expires in 30 days.</p>` +
    `</div>`;

  const sent = await sendEmail({ to: recipients, subject, html, text });
  if (!sent.ok) {
    await logToCloud(admin, {
      level: "error",
      event: "report.resend.failed",
      message: sent.error,
      context: `resend-report inspection=${inspectionSk}`,
      userId,
      orgSk: insp.org_sk ?? null,
      source: SOURCE,
    });
    return json({ ok: false, error: "email_failed", detail: sent.error }, 200);
  }

  await logCloudEvent(admin, SOURCE, "report.resent", {
    userId,
    orgSk: insp.org_sk ?? null,
    data: { inspectionSk, recipientCount: recipients.length, id: sent.id },
  });
  return json({ ok: true, recipientCount: recipients.length });
});
