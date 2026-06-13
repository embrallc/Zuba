// my-day-route Edge Function.
//
// Computes today's drive plan for the authenticated inspector:
//   - Next stop drive duration, distance, traffic level, ETA, lateBy
//   - Daily totals: total drive time, total miles, day start, day end
//
// Architecture:
//   1. Verify JWT → get user_id
//   2. Query inspections from DB (authoritative source — client never sends
//      the list; cancellations mid-day are caught automatically)
//   3. Filter to "remaining" inspections (scheduledAt + apptLength still in
//      the future)
//   4. Compute fingerprint = hash of (sk + scheduledAt + address) for each
//   5. Cache lookup: fingerprint match + expires_at in future → return cached
//   6. Otherwise call Google Routes API with current location + all
//      remaining waypoints in scheduled order. Per-request pricing means
//      multi-waypoint is the same cost as a single leg.
//   7. Build response, upsert cache row with TTL 30 min, return.
//
// "Mode" is a UI label on the response, not a separate codepath:
//   - "upcoming"    — first remaining inspection is still in the future
//   - "in-progress" — first remaining inspection has started (geofence or
//                     scheduledAt + 5 min has passed)
//   - "done"        — no remaining inspections today

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[my-day-route]";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const GEOFENCE_METERS = 150;
const IN_PROGRESS_GRACE_MS = 5 * 60 * 1000; // 5 min after scheduled
// On cache hit, if the user has moved more than this distance from the
// location used to compute the cached drive duration, bust the cache and
// refetch — their real ETA has changed, not just shifted with the clock.
const LOCATION_DRIFT_METERS = 500;

// Gemini daily-briefing model + a hard timeout so a slow LLM never delays the
// route response by more than this. On timeout (or any failure) we fall back
// to a deterministic sentence, so `summary` is never empty.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 4000;

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
  const payload: Record<string, unknown> = {
    ...fields,
    error:
      anyErr instanceof Error
        ? anyErr.message
        : (anyErr?.message ?? String(err)),
    code: anyErr?.code,
    details: anyErr?.details,
    hint: anyErr?.hint,
    status: anyErr?.status,
  };
  console.error(`${TAG} ${event}`, JSON.stringify(payload));
}

// ── Types ────────────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number };

type Inspection = {
  inspection_sk: string;
  full_name: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  scheduled_at: string;
  status: string | null;
  latitude: number | null;
  longitude: number | null;
};

type ReqBody = {
  currentLocation: LatLng;
  apptLengthMinutes: number;
  localDateStart: string;
  localDateEnd: string;
  // Minutes east of UTC (dayjs().utcOffset()). Used only to phrase local
  // clock times in the briefing — the payload itself stays in ISO/UTC.
  tzOffsetMinutes?: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const v = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(v));
}

function inspectionAddress(i: Inspection): string {
  return [i.address_line1, i.city, i.state, i.zip_code]
    .filter(Boolean)
    .join(", ");
}

// Fingerprint inputs to detect any change that would invalidate the route
// plan — SK, time, and the full address (geocode may have updated).
function computeFingerprint(inspections: Inspection[]): string {
  return inspections
    .map(
      (i) =>
        `${i.inspection_sk}|${i.scheduled_at}|${inspectionAddress(i)}|${
          i.latitude ?? ""
        },${i.longitude ?? ""}`,
    )
    .join("||");
}

function trafficLevel(
  durationSec: number,
  staticSec: number,
): "light" | "moderate" | "heavy" {
  if (staticSec <= 0) return "light";
  const ratio = durationSec / staticSec;
  if (ratio < 1.1) return "light";
  if (ratio < 1.3) return "moderate";
  return "heavy";
}

// Routes API durations come back as strings like "1850s" — parse the number.
function parseDurationSec(input: string | number | null | undefined): number {
  if (input == null) return 0;
  if (typeof input === "number") return input;
  const m = String(input).match(/^(\d+(?:\.\d+)?)/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

// ── Routes API call ──────────────────────────────────────────────────────────

type Waypoint = LatLng | { address: string };

function waypointForRoutesApi(w: Waypoint): Record<string, unknown> {
  if ("lat" in w) {
    return {
      location: {
        latLng: { latitude: w.lat, longitude: w.lng },
      },
    };
  }
  return { address: w.address };
}

function inspToWaypoint(i: Inspection): Waypoint {
  if (i.latitude != null && i.longitude != null) {
    return { lat: i.latitude, lng: i.longitude };
  }
  return { address: inspectionAddress(i) };
}

async function callRoutesApi(
  apiKey: string,
  origin: LatLng,
  intermediates: Waypoint[],
  destination: Waypoint,
) {
  const body = {
    origin: waypointForRoutesApi(origin),
    destination: waypointForRoutesApi(destination),
    intermediates: intermediates.map(waypointForRoutesApi),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    units: "IMPERIAL",
  };

  const res = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // FieldMask keeps the response small (and the bill cheaper).
        "X-Goog-FieldMask":
          "routes.duration,routes.staticDuration,routes.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.distanceMeters",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Routes API ${res.status}: ${text}`);
  }
  return await res.json();
}

// ── Gemini summary (Phase 3) ───────────────────────────────────────────────

type SummaryFacts = {
  mode: string;
  nextStopName: string;
  scheduledTime: string;
  etaTime: string;
  driveMinutes: number;
  distanceMiles: number;
  trafficLevel: string;
  lateByMinutes: number;
  remainingStops: number;
  totalToday: number;
  dayStartTime: string;
  dayEndTime: string;
  totalDriveMinutes: number;
  totalMiles: number;
};

// Format a UTC ISO timestamp into the inspector's local "h:mm AM/PM" using the
// offset the client sent. We shift the epoch by the offset then read the UTC
// parts, which yields the local wall-clock without a TZ database in Deno.
function formatLocalTime(iso: string, offsetMin: number): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + offsetMin * 60000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatDriveText(totalMin: number): string {
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

// Deterministic fallback briefing — concise + professional. Always available
// even when Gemini is unreachable or the key is unset.
function buildDeterministicSummary(f: SummaryFacts): string {
  const traffic =
    f.trafficLevel === "light"
      ? "light"
      : f.trafficLevel === "heavy"
        ? "heavy"
        : "moderate";
  const driveText = formatDriveText(f.totalDriveMinutes);
  const stopsText =
    f.remainingStops === 1 ? "1 stop left" : `${f.remainingStops} stops left`;

  if (f.mode === "in-progress") {
    const after = Math.max(0, f.remainingStops - 1);
    const afterText =
      after === 0
        ? "This is your last stop of the day."
        : after === 1
          ? "1 more stop after this."
          : `${after} more stops after this.`;
    return `You're on site at ${f.nextStopName}. ${afterText} About ${driveText} of driving across the day.`;
  }

  if (f.lateByMinutes > 0) {
    return `${f.driveMinutes}-min drive to ${f.nextStopName} in ${traffic} traffic puts you about ${f.lateByMinutes} min behind, with ${stopsText}. Text your client that you're running a little late — new ETA ${f.etaTime}.`;
  }

  return `${f.driveMinutes}-min drive to ${f.nextStopName} — ${traffic} traffic, on schedule for ${f.etaTime}, with ${stopsText} today. Send your client a quick text that you're on the way.`;
}

// Ask Gemini to phrase the briefing. Returns null on any failure (missing key,
// timeout, malformed response) so the caller falls back to the deterministic
// copy. Gemini only rewords the supplied facts — it must not invent or
// recompute them. responseSchema guarantees parseable JSON.
async function generateSummary(
  apiKey: string | undefined,
  facts: SummaryFacts,
): Promise<string | null> {
  if (!apiKey) return null;

  const systemPrompt =
    `You are a briefing assistant for a home inspector's daily route dashboard. ` +
    `Given structured facts about the inspector's next stop and their day, write a ` +
    `concise, professional briefing of about two sentences. First cover the drive to ` +
    `the next stop (time and traffic) and whether they're on schedule. Then ALWAYS ` +
    `close with a reminder to text their client: if lateByMinutes is 0, remind them ` +
    `to text the client that they're on the way; if lateByMinutes is greater than 0, ` +
    `remind them to text the client that they're running a little late and to share ` +
    `the new ETA (use the etaTime value). Exception: if mode is "in-progress" the ` +
    `inspector is already on site, so skip the text reminder and just note their ` +
    `progress through the day. Use the provided clock times and figures exactly — do ` +
    `not invent, omit, or recompute anything. No headers, no lists, no emoji; plain ` +
    `conversational sentences.`;

  const reqBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(facts) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      // Gemini's responseSchema uses the proto `Type` enum — values MUST be
      // uppercase ("OBJECT"/"STRING"). Lowercase returns a 400, which silently
      // forces the deterministic fallback on every call.
      responseSchema: {
        type: "OBJECT",
        properties: { summary: { type: "STRING" } },
        required: ["summary"],
      },
      temperature: 0.3,
      maxOutputTokens: 256,
      // gemini-2.5-flash thinks by default; for a one-line structured summary
      // that just wastes tokens/latency and can exhaust maxOutputTokens before
      // any text is emitted (empty response → silent fallback). Disable it.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      logError("gemini_http_error", null, { status: res.status, text });
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    const summary =
      typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
    return summary || null;
  } catch (e) {
    logError("gemini_failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // 1. JWT verify
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      logError("missing_token", null);
      return json({ error: "missing_token" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const routesApiKey = Deno.env.get("GOOGLE_ROUTES_API_KEY");
    // Optional — if unset, the briefing falls back to deterministic copy.
    const geminiKey = Deno.env.get("GEMINI_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      logError("missing_supabase_env", null, {
        hasUrl: !!supabaseUrl,
        hasAnon: !!anonKey,
        hasService: !!serviceKey,
      });
      return json({ error: "server_misconfigured" }, 500);
    }
    if (!routesApiKey) {
      logError("missing_routes_api_key", null);
      return json({ error: "server_misconfigured" }, 500);
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !userData?.user) {
      logError("invalid_token", userErr);
      return json({ error: "invalid_token" }, 401);
    }
    const userId = userData.user.id;

    // 2. Parse body
    const body: ReqBody = await req.json();
    const {
      currentLocation,
      apptLengthMinutes,
      localDateStart,
      localDateEnd,
      tzOffsetMinutes,
    } = body ?? ({} as ReqBody);

    if (
      !currentLocation ||
      typeof currentLocation.lat !== "number" ||
      typeof currentLocation.lng !== "number"
    ) {
      return json({ error: "missing_location" }, 400);
    }
    if (!localDateStart || !localDateEnd) {
      return json({ error: "missing_date_range" }, 400);
    }
    const apptMs = Math.max(15, apptLengthMinutes ?? 60) * 60 * 1000;
    const tzOffsetMin = Number.isFinite(tzOffsetMinutes)
      ? (tzOffsetMinutes as number)
      : 0;

    const admin = createClient(supabaseUrl, serviceKey);

    // 3. Query today's inspections — DB is source of truth
    const { data: inspections, error: queryErr } = await admin
      .from("inspections")
      .select(
        "inspection_sk, full_name, address_line1, city, state, zip_code, scheduled_at, status, latitude, longitude",
      )
      .eq("user_id", userId)
      .eq("_deleted", false)
      .gte("scheduled_at", localDateStart)
      .lte("scheduled_at", localDateEnd)
      .order("scheduled_at", { ascending: true });

    if (queryErr) {
      logError("inspections_query_failed", queryErr, { userId });
      return json({ error: "db_error" }, 500);
    }

    const all = (inspections ?? []) as Inspection[];
    const nowMs = Date.now();

    // 4. Filter to "remaining" — OPEN stops whose appointment window hasn't
    // ended yet. CLOSED (completed) stops are dropped here so they're neither
    // route waypoints nor part of the fingerprint; completing one therefore
    // shrinks `remaining`, changes the fingerprint, and triggers a fresh plan
    // for the next stop. (`all` still counts them, so totalToday stays honest.)
    const remaining = all.filter((i) => {
      if ((i.status ?? "OPEN") === "CLOSED") return false;
      const start = new Date(i.scheduled_at).getTime();
      return Number.isFinite(start) && start + apptMs > nowMs;
    });

    const dateLabel = localDateStart.slice(0, 10);
    const cacheKey = `mydayroute:${userId}:${dateLabel}`;

    // 5. Done mode — no API call, no cache write
    if (remaining.length === 0) {
      const payload = {
        mode: "done",
        nextStop: null,
        dailyTotals: null,
        summary:
          all.length === 0
            ? "No inspections scheduled today."
            : "All inspections complete for today.",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
      };
      logInfo("done", { userId, totalToday: all.length });
      return json(payload);
    }

    const fingerprint = computeFingerprint(remaining);

    // In-progress detection: is `now` inside the appointment window of the
    // next remaining (OPEN) stop? If so the inspector is on-site, so we serve
    // the cached plan and never call Routes (see 6a). CLOSED stops are already
    // excluded from `remaining`, so completing one advances `remaining[0]`,
    // changes the fingerprint, and frees a fresh call for the next stop.
    const topStartMs = new Date(remaining[0].scheduled_at).getTime();
    const inProgress =
      Number.isFinite(topStartMs) &&
      topStartMs <= nowMs &&
      nowMs < topStartMs + apptMs;

    // 6. Cache lookup
    const { data: cached, error: cacheErr } = await admin
      .from("route_cache")
      .select("payload, fingerprint, expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cacheErr) {
      logError("cache_lookup_failed", cacheErr, { cacheKey });
      // Non-fatal — proceed to live fetch
    }

    if (cached && cached.fingerprint === fingerprint) {
      const cachedPayload = cached.payload as Record<string, any>;

      // 6a. On-site short-circuit. While the inspector is inside the current
      // stop's appointment window, NEVER call Routes — serve the cached plan
      // regardless of TTL or how far they've moved. A 90-min inspection would
      // otherwise blow past the 30-min cache and bill a Routes call on every
      // app open while they take photos / fill out the form. Completing the
      // stop changes the fingerprint, which falls through to a fresh call.
      if (inProgress) {
        const out: Record<string, any> = {
          ...cachedPayload,
          mode: "in-progress",
          fromCache: true,
        };
        if (out.nextStop) {
          // The drive is done — show arrival as "now" and surface how far
          // into (or past) the scheduled start they are, instead of a stale
          // drive-time countdown.
          out.nextStop = {
            ...out.nextStop,
            etaIso: new Date(nowMs).toISOString(),
            lateByMinutes: Math.max(
              0,
              Math.round((nowMs - topStartMs) / 60000),
            ),
          };
        }
        logInfo("cache_hit_in_progress", { userId, cacheKey });
        return json(out);
      }

      // 6b. Normal cache hit — only while unexpired and the user hasn't moved
      // meaningfully since the plan was built.
      if (new Date(cached.expires_at).getTime() > nowMs) {
        const cachedOrigin = cachedPayload?.origin as LatLng | undefined;
        const movedMeters =
          cachedOrigin?.lat != null && cachedOrigin?.lng != null
            ? haversineMeters(currentLocation, cachedOrigin)
            : Number.POSITIVE_INFINITY;

        if (movedMeters <= LOCATION_DRIFT_METERS) {
          // Drive duration is fixed by the last upstream call; recompute ETA
          // + lateBy against `now` so a user waiting at home sees the
          // countdown advance instead of a frozen original ETA.
          const out: Record<string, any> = { ...cachedPayload };
          if (out.nextStop) {
            const driveSec = Number(out.nextStop.driveDurationSec) || 0;
            const scheduledMs = new Date(out.nextStop.scheduledAt).getTime();
            const etaMs = nowMs + driveSec * 1000;
            out.nextStop = {
              ...out.nextStop,
              etaIso: new Date(etaMs).toISOString(),
              lateByMinutes: Math.max(
                0,
                Math.round((etaMs - scheduledMs) / 60000),
              ),
            };
          }
          out.fromCache = true;
          logInfo("cache_hit", {
            userId,
            cacheKey,
            movedMeters: Math.round(movedMeters),
          });
          return json(out);
        }

        // Cache exists but the user has moved meaningfully since it was
        // built — fall through to fresh fetch.
        logInfo("cache_busted_location_drift", {
          userId,
          cacheKey,
          movedMeters: Math.round(movedMeters),
        });
      }
    }

    // 7. Live fetch from Routes API
    const intermediates = remaining.slice(0, -1).map(inspToWaypoint);
    const destination = inspToWaypoint(remaining[remaining.length - 1]);

    // Audit log — each `google_routes_call` line corresponds to one
    // outbound (billable) Google Routes API request. Filter the Edge
    // Function logs by this string to monitor usage / spend per day or
    // per user.
    logInfo("google_routes_call", {
      userId,
      date: dateLabel,
      stops: remaining.length,
      cacheKey,
    });

    let routesResp: Record<string, unknown>;
    try {
      routesResp = await callRoutesApi(
        routesApiKey,
        currentLocation,
        intermediates,
        destination,
      );
    } catch (e) {
      logError("routes_api_failed", e, { userId, stops: remaining.length });
      return json({ error: "routes_api_failed" }, 502);
    }

    const route = (routesResp?.routes as Array<Record<string, unknown>>)?.[0];
    if (!route) {
      logError("routes_api_empty", null, { userId, routesResp });
      return json({ error: "no_route" }, 502);
    }

    const legs = (route.legs ?? []) as Array<Record<string, unknown>>;
    const totalDurationSec = parseDurationSec(route.duration as string);
    const totalStaticSec = parseDurationSec(route.staticDuration as string);
    const totalDistanceMeters = (route.distanceMeters as number) ?? 0;

    const firstLeg = legs[0] ?? {};
    const firstLegDurationSec = parseDurationSec(firstLeg.duration as string);
    const firstLegStaticSec = parseDurationSec(
      firstLeg.staticDuration as string,
    );
    const firstLegDistanceMeters = (firstLeg.distanceMeters as number) ?? 0;

    // 8. Build next-stop block + mode
    const nextStop = remaining[0];
    const nextStopCoords =
      nextStop.latitude != null && nextStop.longitude != null
        ? { lat: nextStop.latitude, lng: nextStop.longitude }
        : null;
    const distanceToNext = nextStopCoords
      ? haversineMeters(currentLocation, nextStopCoords)
      : Number.POSITIVE_INFINITY;

    const nextStartMs = new Date(nextStop.scheduled_at).getTime();
    const isInProgress =
      distanceToNext < GEOFENCE_METERS ||
      nowMs > nextStartMs + IN_PROGRESS_GRACE_MS;

    const etaMs = nowMs + firstLegDurationSec * 1000;
    const lateByMinutes = Math.max(
      0,
      Math.round((etaMs - nextStartMs) / 60000),
    );

    // 9. Daily totals
    const lastInsp = remaining[remaining.length - 1];
    const dayStartIso = new Date(
      nextStartMs - firstLegDurationSec * 1000,
    ).toISOString();
    const dayEndIso = new Date(
      new Date(lastInsp.scheduled_at).getTime() + apptMs,
    ).toISOString();

    const payload = {
      mode: isInProgress ? "in-progress" : "upcoming",
      nextStop: {
        inspectionSk: nextStop.inspection_sk,
        fullName: nextStop.full_name ?? "Inspection",
        address: inspectionAddress(nextStop),
        scheduledAt: nextStop.scheduled_at,
        driveDurationSec: firstLegDurationSec,
        driveDistanceMeters: firstLegDistanceMeters,
        trafficLevel: trafficLevel(firstLegDurationSec, firstLegStaticSec),
        etaIso: new Date(etaMs).toISOString(),
        lateByMinutes,
      },
      dailyTotals: {
        totalDriveSec: totalDurationSec,
        totalStaticDriveSec: totalStaticSec,
        totalDistanceMeters,
        dayStartIso,
        dayEndIso,
        remainingStops: remaining.length,
        totalToday: all.length,
      },
      summary: null as string | null,
      // Stamped onto the cached row so a future cache hit can detect
      // location drift and bust the cache when the user has actually
      // moved (vs. just sat at home).
      origin: currentLocation,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };

    // 9b. Daily briefing. Gemini phrases the facts; on any failure we fall
    // back to a deterministic sentence so `summary` is never empty. This is
    // the ONLY place Gemini runs — the result is cached in the payload, so
    // cache hits / on-site serves / drift recomputes all return it with no
    // extra Gemini cost (same rate-limit as the Routes call above).
    const summaryFacts: SummaryFacts = {
      mode: payload.mode,
      nextStopName: nextStop.full_name ?? "your next stop",
      scheduledTime: formatLocalTime(nextStop.scheduled_at, tzOffsetMin),
      etaTime: formatLocalTime(payload.nextStop.etaIso, tzOffsetMin),
      driveMinutes: Math.round(firstLegDurationSec / 60),
      distanceMiles: Math.round((firstLegDistanceMeters / 1609.344) * 10) / 10,
      trafficLevel: payload.nextStop.trafficLevel,
      lateByMinutes,
      remainingStops: remaining.length,
      totalToday: all.length,
      dayStartTime: formatLocalTime(dayStartIso, tzOffsetMin),
      dayEndTime: formatLocalTime(dayEndIso, tzOffsetMin),
      totalDriveMinutes: Math.round(totalDurationSec / 60),
      totalMiles: Math.round((totalDistanceMeters / 1609.344) * 10) / 10,
    };
    payload.summary =
      (await generateSummary(geminiKey, summaryFacts)) ??
      buildDeterministicSummary(summaryFacts);

    // 10. Cache upsert
    const expiresAtIso = new Date(nowMs + CACHE_TTL_MS).toISOString();
    const { error: upsertErr } = await admin.from("route_cache").upsert(
      {
        cache_key: cacheKey,
        user_id: userId,
        payload,
        fingerprint,
        expires_at: expiresAtIso,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" },
    );

    if (upsertErr) {
      logError("cache_upsert_failed", upsertErr, { cacheKey });
      // Non-fatal — payload is returned regardless
    }

    logInfo("fresh_fetch", {
      userId,
      stops: remaining.length,
      mode: payload.mode,
      lateByMinutes,
      cached: false,
    });
    return json(payload);
  } catch (e) {
    logError("unhandled", e);
    return json({ error: "internal" }, 500);
  }
});
