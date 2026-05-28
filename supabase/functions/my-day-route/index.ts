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
  latitude: number | null;
  longitude: number | null;
};

type ReqBody = {
  currentLocation: LatLng;
  apptLengthMinutes: number;
  localDateStart: string;
  localDateEnd: string;
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
    const { currentLocation, apptLengthMinutes, localDateStart, localDateEnd } =
      body ?? ({} as ReqBody);

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

    const admin = createClient(supabaseUrl, serviceKey);

    // 3. Query today's inspections — DB is source of truth
    const { data: inspections, error: queryErr } = await admin
      .from("inspections")
      .select(
        "inspection_sk, full_name, address_line1, city, state, zip_code, scheduled_at, latitude, longitude",
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

    // 4. Filter to "remaining" — appt window hasn't ended yet
    const remaining = all.filter((i) => {
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

    if (
      cached &&
      cached.fingerprint === fingerprint &&
      new Date(cached.expires_at).getTime() > nowMs
    ) {
      const cachedPayload = cached.payload as Record<string, any>;
      const cachedOrigin = cachedPayload?.origin as LatLng | undefined;
      const movedMeters =
        cachedOrigin?.lat != null && cachedOrigin?.lng != null
          ? haversineMeters(currentLocation, cachedOrigin)
          : Number.POSITIVE_INFINITY;

      if (movedMeters <= LOCATION_DRIFT_METERS) {
        // Cache hit. Drive duration is fixed by the last upstream call;
        // recompute ETA + lateBy against `now` so a user waiting at home
        // sees the countdown advance instead of a frozen original ETA.
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
      summary: null, // Phase 3 — Gemini
      // Stamped onto the cached row so a future cache hit can detect
      // location drift and bust the cache when the user has actually
      // moved (vs. just sat at home).
      origin: currentLocation,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };

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
