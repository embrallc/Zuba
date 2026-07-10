// Google Places API (New) — address autocomplete for the Add/Edit Inspection
// screen. Session-based billing: keystrokes during a session are FREE when the
// session ends with a Place Details (Pro) call, so real cost ≈ one Place Details
// per completed address (first 5,000/mo free). See the plan + docs/environments.md.
//
// KEY: EXPO_PUBLIC_GOOGLE_PLACES_KEY is an *application-restricted* client key
// (locked to our iOS bundle ids + Places API New only) — NOT a bearer secret
// like Gemini/Stripe. It ships in the app bundle (Google's intended model for
// Maps/Places client keys) but its VALUE is never committed: it lives in
// .env.local (gitignored) for dev and in EAS environment variables for builds.
//
// This is a raw-REST layer (no library — react-native-google-places-autocomplete
// targets the LEGACY API). Because we call REST directly rather than through the
// Maps SDK, the app must attest its identity with the platform header below or
// the restricted key 403s ("requests from this iOS app are blocked").

import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { logError } from "../db/logs";
import { isOnline } from "./connectivity";

const PLACES_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY;
const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_BASE = "https://places.googleapis.com/v1/places";

// Minimum characters before we spend an Autocomplete request.
const MIN_QUERY = 3;

// True only when a key is present; the UI hides itself (falls back to manual
// entry) when this is false, so a missing key never breaks address entry.
export function placesConfigured() {
  return typeof PLACES_KEY === "string" && PLACES_KEY.length > 0;
}

// One session token spans a user's typing + the final Place Details call; mint a
// fresh one after each completed address so the next lookup bills as its own
// session. Reuses expo-crypto (already a dep) — same source as the calendar deviceId.
export function newSessionToken() {
  return Crypto.randomUUID();
}

// Restricted-key attestation headers. On iOS we send the bundle id; the value is
// the fully-resolved (per-env) id from app.config.js, so it's .dev / .staging /
// bare prod automatically. Android needs its own Android-restricted key + cert
// header — not wired until Android launch (we're iOS-first for TestFlight).
function baseHeaders() {
  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": PLACES_KEY ?? "",
  };
  if (Platform.OS === "ios") {
    const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
    if (bundleId) headers["X-Ios-Bundle-Identifier"] = bundleId;
  } else if (Platform.OS === "android") {
    const pkg = Constants.expoConfig?.android?.package;
    if (pkg) headers["X-Android-Package"] = pkg;
    // NOTE: Android also requires X-Android-Cert (signing SHA-1) + its OWN
    // Android-restricted key before this works on Android. iOS-first for now.
  }
  return headers;
}

// Autocomplete predictions for the current input. Returns [] on any non-happy
// path (offline, no key, too-short, aborted, error) so callers never have to
// branch — the dropdown just shows nothing. Pass an AbortController signal so a
// newer keystroke can cancel this in-flight request.
export async function fetchAddressPredictions(input, sessionToken, { signal } = {}) {
  const query = (input ?? "").trim();
  if (!placesConfigured() || query.length < MIN_QUERY) return [];
  // Network enrichment — skip cleanly offline (mirrors the geocode guard).
  if (!isOnline()) return [];

  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: baseHeaders(),
      signal,
      body: JSON.stringify({
        input: query,
        sessionToken,
        includedRegionCodes: ["us"],
        includedPrimaryTypes: ["street_address", "premise", "subpremise"],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logError(
        new Error(`places autocomplete ${res.status}: ${detail.slice(0, 300)}`),
        "placesAutocomplete.fetchAddressPredictions",
      );
      return [];
    }
    const json = await res.json();
    const suggestions = Array.isArray(json?.suggestions) ? json.suggestions : [];
    return suggestions
      .map((s) => s?.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        primaryText:
          p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      }))
      .filter((p) => p.placeId && p.primaryText);
  } catch (e) {
    // A superseded keystroke aborts this fetch — expected, not an error.
    if (e?.name === "AbortError") return [];
    logError(e, "placesAutocomplete.fetchAddressPredictions");
    return [];
  }
}

// Fetch the chosen place's structured address + authoritative lat/lng. ENDS the
// billing session (pass the same token used for the autocomplete requests).
// Returns null on any failure; caller keeps whatever the user typed.
export async function fetchPlaceDetails(placeId, sessionToken) {
  if (!placesConfigured() || !placeId) return null;
  if (!isOnline()) return null;

  try {
    const url =
      `${DETAILS_BASE}/${encodeURIComponent(placeId)}` +
      `?sessionToken=${encodeURIComponent(sessionToken ?? "")}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...baseHeaders(),
        "X-Goog-FieldMask": "addressComponents,location,formattedAddress",
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logError(
        new Error(`places details ${res.status}: ${detail.slice(0, 300)}`),
        "placesAutocomplete.fetchPlaceDetails",
      );
      return null;
    }
    return parseAddress(await res.json());
  } catch (e) {
    logError(e, "placesAutocomplete.fetchPlaceDetails");
    return null;
  }
}

// Map a Place Details response into our five form fields + coordinates. Uses the
// short name for state ("IL", to match the 2-char State input) and long names
// elsewhere; falls back through locality → sublocality → postal_town → county so
// rural addresses still get a city.
function parseAddress(place) {
  const comps = Array.isArray(place?.addressComponents)
    ? place.addressComponents
    : [];
  const get = (type, useShort = false) => {
    const c = comps.find(
      (x) => Array.isArray(x?.types) && x.types.includes(type),
    );
    if (!c) return "";
    return (useShort ? c.shortText : c.longText) ?? c.longText ?? c.shortText ?? "";
  };

  const line1 = [get("street_number"), get("route")]
    .filter(Boolean)
    .join(" ")
    .trim();
  const city =
    get("locality") ||
    get("sublocality") ||
    get("postal_town") ||
    get("administrative_area_level_2");
  const state = get("administrative_area_level_1", true);
  const zip = get("postal_code");
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;

  return {
    line1,
    city,
    state,
    zip,
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
    formatted: place?.formattedAddress ?? "",
  };
}
