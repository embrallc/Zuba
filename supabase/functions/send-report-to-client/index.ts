// send-report-to-client Edge Function (internal-only).
//
// Ensures the inspection has a rendered PDF (rendering one via the Railway
// worker's /api/render-internal if needed), signs a long-TTL link, and emails it
// to the inspection's report recipients via Resend. Called by reconcile-inspection;
// it owns no state — the reconciler claims report_state='sending' around it.
//
// Auth: the caller must present the service-role key as the bearer (trusted
// server-to-server). User JWTs are rejected.
//
// Body: { inspectionSk }. Returns: { ok, recipientCount } or { ok:false, error }.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { channelRecipients, sendEmail } from "../_shared/email.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[send-report-to-client]";
const REPORT_BUCKET = "inspection-reports";
const LINK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

// Minutes east of UTC for an IANA timezone at "now" — so the auto-generated
// report stamps local times rather than UTC.
function tzOffsetMinutes(timeZone: string | null): number {
  if (!timeZone) return 0;
  try {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const m: Record<string, string> = {};
    for (const p of dtf.formatToParts(now)) m[p.type] = p.value;
    const asUTC = Date.UTC(
      +m.year,
      +m.month - 1,
      +m.day,
      +m.hour,
      +m.minute,
      +m.second,
    );
    return Math.round((asUTC - now.getTime()) / 60000);
  } catch (_) {
    return 0;
  }
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (jwt !== serviceKey) return json({ error: "forbidden" }, 403);

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: { inspectionSk?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const inspectionSk = body.inspectionSk;
  if (!inspectionSk) return json({ ok: false, error: "missing_inspection" }, 400);

  // Load the inspection + recipients.
  const { data: insp, error: inspErr } = await admin
    .from("inspections")
    .select(
      "inspection_sk, user_id, full_name, address_line1, city, state, email, report_recipients",
    )
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (inspErr) {
    logError("inspection_lookup_failed", inspErr, { inspectionSk });
    return json({ ok: false, error: "db_error" }, 500);
  }
  if (!insp) return json({ ok: false, error: "inspection_not_found" }, 404);

  // Recipients = whoever is subscribed to the report channel (new object form),
  // or everyone + primary (legacy form).
  const recipients = channelRecipients(
    insp.report_recipients,
    insp.email,
    "report",
  );
  if (recipients.length === 0) {
    logInfo("no_recipients", { inspectionSk });
    return json({ ok: false, error: "no_recipients" }, 200);
  }

  // Org timezone → offset, so the auto-generated report shows local times.
  let orgTz: string | null = null;
  if (insp.user_id) {
    const { data: owner } = await admin
      .from("users")
      .select("org_sk")
      .eq("id", insp.user_id)
      .maybeSingle();
    if (owner?.org_sk) {
      const { data: org } = await admin
        .from("organizations")
        .select("timezone")
        .eq("org_sk", owner.org_sk)
        .maybeSingle();
      orgTz = org?.timezone ?? null;
    }
  }

  // Always render a FRESH PDF right before sending. Auto-send is one-time
  // (reconcile claims report_state around this call and sets 'sent'), so the PDF
  // we email is the client's authoritative copy — it MUST reflect the CURRENT
  // cloud answers, never a cached earlier render. We used to reuse the latest
  // inspection_reports row and only render `if (!storagePath)`; that mailed a
  // stale report whenever one had already been rendered before the final edits —
  // e.g. the inspector taps Generate to preview, fixes a typo/adds a photo, then
  // marks Complete → auto-send reused the pre-fix preview. Rendering here is
  // cheap (one worker call, ~once per inspection) and render-internal records the
  // new inspection_reports row itself, so Share/restore still find the newest.
  // Service-role bearer = trusted server-to-server.
  const workerUrl = (Deno.env.get("REPORT_WORKER_URL") ?? "").replace(/\/$/, "");
  if (!workerUrl) {
    logError("worker_not_configured", new Error("REPORT_WORKER_URL not set"), {
      inspectionSk,
    });
    return json({ ok: false, error: "generate_failed" }, 200);
  }
  let storagePath: string | null = null;
  try {
    const res = await fetch(`${workerUrl}/api/render-internal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inspectionSk,
        tzOffsetMinutes: tzOffsetMinutes(orgTz),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.storagePath) {
      logError("generate_failed", new Error(data?.error ?? `status ${res.status}`), {
        inspectionSk,
      });
      return json({ ok: false, error: "generate_failed" }, 200);
    }
    storagePath = data.storagePath;
  } catch (e) {
    logError("generate_threw", e, { inspectionSk });
    return json({ ok: false, error: "generate_failed" }, 200);
  }

  // Long-TTL signed link.
  const { data: signed, error: signErr } = await admin.storage
    .from(REPORT_BUCKET)
    .createSignedUrl(storagePath!, LINK_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    logError("sign_failed", signErr, { storagePath });
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
    logError("email_failed", new Error(sent.error), { inspectionSk });
    return json({ ok: false, error: "email_failed", detail: sent.error }, 200);
  }

  logInfo("sent", { inspectionSk, recipientCount: recipients.length, id: sent.id });
  return json({ ok: true, recipientCount: recipients.length });
});
