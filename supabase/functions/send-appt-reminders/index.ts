// send-appt-reminders Edge Function — outbound day-before SMS reminders.
//
// Invoked hourly by pg_cron (service-role bearer). Each run is a sweep:
//   - For every org with a timezone, check its LOCAL hour. Only orgs where it's
//     currently 10:00 local are in their send window (so one hourly cron fans
//     out across all timezones; each org fires once/day).
//   - For those orgs, find inspections scheduled for TOMORROW (org-local) that
//     opted into a reminder and haven't been sent yet, and text the client.
//   - Flip appt_reminder_status PENDING→SENT (idempotent: one send per job).
//
// All timezone math is done against the org's IANA `timezone` via Intl — never
// server/UTC wall-clock — so "tomorrow" and "10am" are correct everywhere.
//
// Auth: internal only (bearer must equal the service-role key). Twilio creds and
// the service-role key come from EF env; nothing is ever in the client bundle.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { logCloudEvent } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[send-appt-reminders]";
const SOURCE = "ef:send-appt-reminders";
const SEND_HOUR = 10; // 10am local

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

// ── Timezone helpers (no external tz lib; Intl is enough) ────────────────────

// Wall-clock parts of an instant in a given IANA zone.
function zonedParts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: +map.year,
    month: +map.month,
    day: +map.day,
    hour: +map.hour === 24 ? 0 : +map.hour,
    minute: +map.minute,
    second: +map.second,
  };
}

// UTC epoch-ms for a wall-clock time interpreted in `timeZone` (date-fns-tz trick).
function zonedTimeToUtcMs(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const back = zonedParts(new Date(asUtc), timeZone);
  const backUtc = Date.UTC(
    back.year,
    back.month - 1,
    back.day,
    back.hour,
    back.minute,
    back.second,
  );
  const offset = backUtc - asUtc; // how far ahead of UTC the zone is
  return asUtc - offset;
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
  // key). ignoreHour bypasses the 10am-local gate so a manual staging invoke
  // sends immediately; orgSk limits the sweep to one org. The tomorrow-date +
  // opt-in + valid-phone gates still apply, so this can't fire anything that a
  // real 10am run wouldn't.
  let body: { ignoreHour?: boolean; orgSk?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const ignoreHour = body.ignoreHour === true;

  const now = new Date();
  let orgsInWindow = 0;
  let sent = 0;
  let failed = 0;
  let skippedNoPhone = 0;

  // Orgs with a configured timezone whose local hour is the send hour.
  const { data: orgs, error: orgErr } = await admin
    .from("organizations")
    .select("org_sk, timezone")
    .not("timezone", "is", null);
  if (orgErr) {
    logError("orgs_query_failed", orgErr);
    return json({ error: "db_error" }, 500);
  }

  for (const org of orgs ?? []) {
    if (body.orgSk && org.org_sk !== body.orgSk) continue;
    const tz = org.timezone as string;
    let localHour: number;
    let tomorrowStartMs: number;
    let dayAfterStartMs: number;
    try {
      const np = zonedParts(now, tz);
      localHour = np.hour;
      if (localHour !== SEND_HOUR && !ignoreHour) continue;
      // Tomorrow's local calendar date.
      const t = new Date(Date.UTC(np.year, np.month - 1, np.day + 1));
      const ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1, td = t.getUTCDate();
      tomorrowStartMs = zonedTimeToUtcMs(ty, tm, td, 0, 0, 0, tz);
      // Day after tomorrow (DST-safe upper bound; not start+24h).
      const a = new Date(Date.UTC(np.year, np.month - 1, np.day + 2));
      dayAfterStartMs = zonedTimeToUtcMs(
        a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate(), 0, 0, 0, tz,
      );
    } catch (e) {
      logError("bad_timezone", e, { orgSk: org.org_sk, timezone: tz });
      continue;
    }
    orgsInWindow++;

    // Inspectors in this org → name lookup + the user_id set to filter by.
    const { data: users } = await admin
      .from("users")
      .select("id, fname, lname")
      .eq("org_sk", org.org_sk);
    const ids = (users ?? []).map((u) => u.id);
    if (ids.length === 0) continue;
    const nameById = new Map<string, string>();
    for (const u of users ?? []) {
      nameById.set(u.id, `${u.fname ?? ""} ${u.lname ?? ""}`.trim());
    }

    // Tomorrow's opted-in, not-yet-sent, non-terminal inspections.
    const { data: insps, error: inspErr } = await admin
      .from("inspections")
      .select("inspection_sk, user_id, full_name, phone, scheduled_at, _version")
      .in("user_id", ids)
      .eq("has_appt_reminder", true)
      .eq("appt_reminder_status", "PENDING")
      .eq("_deleted", false)
      .not("status", "in", "(CANCELLED,CLOSED)")
      .gte("scheduled_at", new Date(tomorrowStartMs).toISOString())
      .lt("scheduled_at", new Date(dayAfterStartMs).toISOString());
    if (inspErr) {
      logError("insp_query_failed", inspErr, { orgSk: org.org_sk });
      continue;
    }

    for (const insp of insps ?? []) {
      const to = toE164(insp.phone);
      if (!to) {
        skippedNoPhone++;
        logInfo("skip_no_phone", { inspectionSk: insp.inspection_sk });
        continue;
      }
      const when = new Date(insp.scheduled_at);
      const time = formatTime(when, tz);
      const date = formatDate(when, tz);
      const inspector = nameById.get(insp.user_id) || "your inspector";
      const body =
        `Your inspection is scheduled for ${time} tomorrow, ${date}. ` +
        `Your inspector will be ${inspector}. ` +
        `Reply C to confirm or X to cancel.`;

      const r = await sendSms(to, body);
      if (!r.ok) {
        failed++;
        logError("sms_failed", new Error(r.detail), { inspectionSk: insp.inspection_sk });
        continue; // leave PENDING; only the one 10am run retries
      }
      // Send-first, then flip (guarded) so a lost send is never marked sent.
      const nextVersion = Number(insp._version ?? 1) + 1;
      await admin
        .from("inspections")
        .update({
          appt_reminder_status: "SENT",
          _version: nextVersion,
          _last_changed_at: Date.now(),
        })
        .eq("inspection_sk", insp.inspection_sk)
        .eq("appt_reminder_status", "PENDING");
      sent++;
      logInfo("sent", { inspectionSk: insp.inspection_sk });
    }
  }

  const summary = { ok: true, orgsInWindow, sent, failed, skippedNoPhone };
  logInfo("sweep_done", summary);
  // Only record a telemetry row when the sweep actually did something — most
  // hourly runs are no-ops (no org in its 10am window) and would just be noise.
  if (sent > 0 || failed > 0) {
    void logCloudEvent(admin, SOURCE, failed > 0 ? "reminder.failed" : "reminder.sent", {
      data: { orgsInWindow, sent, failed, skippedNoPhone },
    });
  }
  return json(summary);
});
