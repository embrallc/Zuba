// send-appt-reminders Edge Function — day-before appointment SMS reminders.
//
// Invoked hourly by pg_cron (service-role bearer). Each run asks the DB, via the
// set-based `due_appt_reminders()` function, for exactly the inspections to text
// right now: opted-in, still PENDING, not deleted/cancelled/closed, with a phone,
// whose appointment is TOMORROW in the org's timezone and whose org-local hour is
// at/after the 9am floor (no texts before 9am; no upper cap). Then it texts each
// client and flips appt_reminder_status PENDING->SENT (idempotent: one send per
// PENDING episode — a reschedule re-arms it to PENDING via a DB trigger).
//
// Why the DB does the selection: it keeps this O(reminders-due-soon) via a partial
// index instead of an org-by-org N+1 loop, so it scales with the reminder volume,
// not the org/user count. All timezone math lives in the SQL function.
//
// Auth: internal only (bearer must equal the service-role key). Twilio creds and
// the service-role key come from EF env; nothing is ever in the client bundle.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { logCloudEvent } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[send-appt-reminders]";
const SOURCE = "ef:send-appt-reminders";
const MIN_SEND_HOUR = 9; // org-local floor: no texts before 9am (no upper cap).
// Fallback zone for an org that hasn't had its timezone persisted yet (the client
// heals it to the owner's device zone on first Settings load). Only used here for
// message formatting; the SQL function applies the same fallback for selection.
const DEFAULT_TZ = "America/Chicago";

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

// Format the appointment time ("10:30 AM") and date ("Mon, Jun 30") in org tz.
function formatTime(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}
function formatDate(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(instant);
}

// Best-effort US E.164 from free-text phone. Returns null if not usable.
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("+")) {
    const d = trimmed.slice(1).replace(/\D/g, "");
    return d.length >= 8 ? `+${d}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function sendSms(to: string, body: string): Promise<{ ok: boolean; detail?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_PHONE_NUMBER");
  if (!sid || !token || !from) {
    return { ok: false, detail: "twilio_env_missing" };
  }
  const auth = btoa(`${sid}:${token}`);
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, detail: (data as { message?: string })?.message ?? `status ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message };
  }
}

interface DueRow {
  inspection_sk: string;
  phone: string | null;
  scheduled_at: string;
  timezone: string | null;
  inspector_name: string | null;
  version: number | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (jwt !== serviceKey) return json({ error: "forbidden" }, 403); // internal only

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Test hooks (internal only — this endpoint already requires the service-role
  // key). ignoreHour drops the 9am floor so a manual staging invoke sends
  // immediately; orgSk scopes the sweep to one org. The tomorrow-date + opt-in +
  // valid-phone gates still apply (they live in due_appt_reminders), so this can't
  // fire anything a real 9am run wouldn't.
  let body: { ignoreHour?: boolean; orgSk?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const ignoreHour = body.ignoreHour === true;

  // One set-based, index-backed query for exactly the rows to text right now.
  const { data: due, error: dueErr } = await admin.rpc("due_appt_reminders", {
    p_min_hour: ignoreHour ? -1 : MIN_SEND_HOUR,
    p_org_sk: body.orgSk ?? null,
  });
  if (dueErr) {
    logError("due_query_failed", dueErr);
    return json({ error: "db_error" }, 500);
  }

  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;

  for (const row of (due ?? []) as DueRow[]) {
    const to = toE164(row.phone);
    if (!to) {
      skippedNoPhone++;
      logInfo("skip_no_phone", { inspectionSk: row.inspection_sk });
      continue;
    }
    const tz = row.timezone || DEFAULT_TZ;
    const when = new Date(row.scheduled_at);
    const time = formatTime(when, tz);
    const date = formatDate(when, tz);
    const inspector = row.inspector_name?.trim() || "your inspector";
    const message =
      `Your inspection is scheduled for ${time} tomorrow, ${date}. ` +
      `Your inspector will be ${inspector}. ` +
      `Reply C to confirm or X to cancel.`;

    const r = await sendSms(to, message);
    if (!r.ok) {
      failed++;
      logError("sms_failed", new Error(r.detail), { inspectionSk: row.inspection_sk });
      continue; // leave PENDING; the next in-window sweep retries
    }
    // Send-first, then flip (guarded on still-PENDING) so a lost send is never
    // marked sent, and concurrent runs can't double-flip the same row.
    const nextVersion = Number(row.version ?? 1) + 1;
    await admin
      .from("inspections")
      .update({
        appt_reminder_status: "SENT",
        _version: nextVersion,
        _last_changed_at: Date.now(),
      })
      .eq("inspection_sk", row.inspection_sk)
      .eq("appt_reminder_status", "PENDING");
    sent++;
    logInfo("sent", { inspectionSk: row.inspection_sk });
  }

  const summary = { ok: true, candidates: (due ?? []).length, sent, failed, skippedNoPhone };
  logInfo("sweep_done", summary);
  // Only record a telemetry row when the sweep actually did something — most hourly
  // runs return no due rows and would just be noise.
  if (sent > 0 || failed > 0) {
    void logCloudEvent(admin, SOURCE, failed > 0 ? "reminder.failed" : "reminder.sent", {
      data: { candidates: (due ?? []).length, sent, failed, skippedNoPhone },
    });
  }
  return json(summary);
});
