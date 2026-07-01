// Two-way calendar sync engine (local, on-device only — no Google/Apple cloud
// APIs, no Edge Functions). Mirrors the notifications integration: db writes
// emit on the bus (db/events.js) and we react; for the calendar→Zuba direction
// (which has no change-notification API) we poll on app foreground.
//
// PUSH (Zuba → calendar): on INSERT/UPDATE/DELETE from local user actions we
//   create / update / delete a system-calendar event in the chosen calendar,
//   stamping the notes with the `#zuba` marker, and record the link on the
//   inspection (CalendarEventId / CalendarOwnerDeviceId / CalendarSnapshot).
//
// PULL (calendar → Zuba): runPull() scans the chosen calendar over a rolling
//   window. Only events that carry `#zuba` (title or notes, case-insensitive)
//   — or that we already own by id — are treated as inspections; everything
//   else is ignored, so an inspector can keep other appointments in the same
//   calendar. New events become inspections; changed events update theirs;
//   vanished events soft-delete theirs.
//
// Loop prevention: every write stores a content snapshot; before any write in
// either direction we compare against it and no-op when equal. Conflicts use
// newest-wins (iOS event lastModifiedDate vs inspection _lastChangedAt; Android
// / ties → calendar wins).

import * as Calendar from "expo-calendar";
import * as Location from "expo-location";
import { DB_EVENTS, subscribe } from "../db/events";
import {
  getActiveCalendarLinks,
  getInspectionById,
  getRetiredCalendarLinks,
  insertInspection,
  setInspectionCalendarFields,
  softDeleteInspection,
  updateInspection,
} from "../db/inspections";
import { logError, logEvent } from "../db/logs";
import { useCalendarStore } from "../stores/useCalendarStore";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const ZUBA_TOKEN = "#zuba";
const TOKEN_RE = /#zuba/i;

// Rolling pull window: a little past so just-cancelled events resolve, ~6
// months ahead for upcoming work.
const WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 183 * 24 * 60 * 60 * 1000;

// Set true while we APPLY remote (calendar→Zuba) changes so the db events those
// writes emit don't re-enter the push handlers and bounce straight back to the
// calendar. JS is single-threaded and emit() is synchronous, so a tight flag
// around each apply is enough.
let applyingRemote = false;

// ─── small helpers ──────────────────────────────────────────────────────────

function getConfig() {
  return useCalendarStore.getState();
}

function configured(cfg) {
  return !!(cfg?.enabled && cfg?.calendarId && cfg?.deviceId);
}

function hasToken(s) {
  return typeof s === "string" && TOKEN_RE.test(s);
}

// Remove the marker and tidy whitespace so it never leaks into FullName/Summary.
function stripToken(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/#zuba/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A calendar event has no structured phone/email fields, so an assistant who
// adds an event has no way to hand the inspector a number to follow up on —
// unless they type it into the notes. Pull the first email and the first
// US-style phone number out of the text and strip them so they don't linger in
// the Summary. Best-effort: order email-first so the phone matcher never grabs
// digits inside an address.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

function extractContact(text) {
  let cleaned = typeof text === "string" ? text : "";
  // Capture EVERY email in the notes (an assistant may list the buyer + the
  // agent + a spouse) — de-duped case-insensitively, first-seen order. `email`
  // is the first (primary); `emails` carries them all for the recipient fan-out.
  const emails = [];
  const seen = new Set();
  for (const m of cleaned.matchAll(EMAIL_RE)) {
    const e = m[0].trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      emails.push(e);
    }
  }
  if (emails.length) cleaned = cleaned.replace(EMAIL_RE, " ");

  let phone = null;
  const ph = cleaned.match(PHONE_RE);
  if (ph) {
    phone = ph[0].trim();
    cleaned = cleaned.replace(ph[0], " ");
  }
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { phone, email: emails[0] ?? null, emails, cleaned };
}

// US state/territory abbreviations — used to validate the 2-letter token we peel
// off as the state, so a random 2-letter word before the ZIP isn't mistaken for one.
const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

// Best-effort US address parse from a free-text calendar location. Apple/Google
// usually render "123 Main St, City, ST 62704, United States". We anchor on the
// ZIP (the LAST 5-digit run — the street number is never last), read the 2-letter
// state right before it, DISCARD anything after the ZIP (the country), and treat
// the remainder as the street, peeling a trailing comma-segment as the city.
// Anything we can't confidently split stays whole in line1 — we never lose data.
function parseUsAddress(location) {
  const raw = typeof location === "string" ? location.trim() : "";
  const out = { line1: raw || null, city: null, state: null, zip: null };
  if (!raw) return out;

  const zips = [...raw.matchAll(/\b\d{5}(?:-\d{4})?\b/g)];
  if (zips.length === 0) return out; // no ZIP → leave the whole string in line1

  const zm = zips[zips.length - 1]; // last 5-digit run = the ZIP
  out.zip = zm[0];
  // Everything before the ZIP; everything after it (the country) is dropped.
  let before = raw.slice(0, zm.index).replace(/[\s,]+$/, "").trim();

  // State = a VALID 2-letter abbreviation standing alone right before the ZIP.
  const st = before.match(/(?:^|[\s,])([A-Za-z]{2})$/);
  if (st && US_STATES.has(st[1].toUpperCase())) {
    out.state = st[1].toUpperCase();
    before = before.slice(0, before.length - st[0].length).replace(/[\s,]+$/, "").trim();
  }

  // Remainder → street (+ city). If comma-delimited, the last segment is almost
  // always the city; otherwise keep it all in line1.
  if (before.includes(",")) {
    const parts = before.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      out.city = parts[parts.length - 1];
      out.line1 = parts.slice(0, -1).join(", ") || null;
    } else {
      out.line1 = before || null;
    }
  } else {
    out.line1 = before || null;
  }
  return out;
}

// Full state name → USPS abbreviation, so a reverse-geocode that returns
// "California" is stored the same 2-letter way as the rest of the app.
const STATE_NAME_TO_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};

// Normalize a reverse-geocode region (iOS usually already gives "CA"; Android /
// some locales give the full name) to a 2-letter code; keep the regex fallback
// when we can't map it.
function normalizeState(region, fallbackState) {
  const r = typeof region === "string" ? region.trim() : "";
  if (!r) return fallbackState ?? null;
  if (r.length === 2 && US_STATES.has(r.toUpperCase())) return r.toUpperCase();
  const mapped = STATE_NAME_TO_ABBR[r.toLowerCase()];
  if (mapped) return mapped;
  return fallbackState ?? (r.length === 2 ? r.toUpperCase() : null);
}

// Resolve a free-text calendar location into canonical, consistently-formatted
// address fields by round-tripping through the OS geocoder — the SAME geocoder
// the Add-Inspection screen uses (no API key, no server). This is what makes a
// "current location" pin and a typed address land identically: both resolve to
// the same coordinates, and reverse-geocoding those coords yields one canonical
// structured address. Best-effort: any failure (throttle, offline, no match)
// falls back to the regex parse, so we never block the import or lose data.
// Returns { line1, city, state, zip, lat, lng }.
async function resolveEventAddress(rawLocation) {
  const fb = parseUsAddress(rawLocation);
  const raw = typeof rawLocation === "string" ? rawLocation.trim() : "";
  const base = { line1: fb.line1, city: fb.city, state: fb.state, zip: fb.zip, lat: null, lng: null };
  if (!raw) return base;
  try {
    const geo = await Location.geocodeAsync(raw);
    const first = geo?.[0];
    if (first?.latitude == null || first?.longitude == null) return base;
    const lat = first.latitude;
    const lng = first.longitude;
    let rev = [];
    try {
      rev = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    } catch (_) {
      // Have coords but no structured breakdown — keep the regex fields + coords.
      return { ...base, lat, lng };
    }
    const p = rev?.[0];
    if (!p) return { ...base, lat, lng };
    const line1 =
      [p.streetNumber, p.street].filter(Boolean).join(" ").trim() ||
      p.name ||
      fb.line1 ||
      null;
    return {
      line1,
      city: p.city ?? fb.city ?? null,
      state: normalizeState(p.region, fb.state),
      zip: p.postalCode ?? fb.zip ?? null,
      lat,
      lng,
    };
  } catch (e) {
    logError(e, `calendarSync.resolveEventAddress addr="${raw.slice(0, 60)}"`);
    return base;
  }
}

function toIso(d) {
  if (!d) return null;
  try {
    return new Date(d).toISOString();
  } catch (_) {
    return null;
  }
}

function addressOneLine(insp) {
  return [
    insp?.AddressLine1,
    insp?.AddressLine2,
    insp?.City,
    insp?.State,
    insp?.ZipCode,
  ]
    .filter((p) => p && String(p).trim())
    .join(", ");
}

// What the calendar event SHOULD look like for an inspection.
function inspectionToEventInput(insp) {
  const start = new Date(insp.ScheduledAt);
  const lengthMin = useSettingsStore.getState()?.apptLengthMinutes ?? 60;
  const end = new Date(start.getTime() + Math.max(15, lengthMin) * 60000);
  const title =
    (insp.FullName && insp.FullName.trim()) ||
    addressOneLine(insp) ||
    "Inspection";
  const location = addressOneLine(insp);
  const base = (insp.Summary || "").trim();
  const notes = base ? `${base}\n\n${ZUBA_TOKEN}` : ZUBA_TOKEN;
  return { title, startDate: start, endDate: end, location, notes };
}

// Content snapshot derived from an inspection (what we will write).
function snapshotFromInspection(insp) {
  const ev = inspectionToEventInput(insp);
  return {
    title: ev.title,
    start: ev.startDate.toISOString(),
    end: ev.endDate.toISOString(),
    location: ev.location || "",
    notes: ev.notes || "",
  };
}

// Content snapshot derived from a fetched calendar event.
function snapshotFromEvent(ev) {
  return {
    title: ev.title || "",
    start: toIso(ev.startDate),
    end: toIso(ev.endDate),
    location: ev.location || "",
    notes: ev.notes || "",
    lastModified: toIso(ev.lastModifiedDate), // iOS only
  };
}

// Equality over CONTENT fields only (lastModified always differs).
function sameContent(a, b) {
  if (!a || !b) return false;
  return (
    (a.title || "") === (b.title || "") &&
    (a.start || "") === (b.start || "") &&
    (a.end || "") === (b.end || "") &&
    (a.location || "") === (b.location || "") &&
    (a.notes || "") === (b.notes || "")
  );
}

function parseSnapshot(str) {
  if (!str) return null;
  try {
    return typeof str === "string" ? JSON.parse(str) : str;
  } catch (_) {
    return null;
  }
}

// True when an error means "the calendar event no longer exists" — so callers can
// heal (recreate) or suppress instead of surfacing it. expo-calendar wraps the
// real reason in a nested cause: the top message is generic ("Calling the
// 'saveEventAsync' function has failed") while the cause carries "Event with id …
// could not be found". So we flatten the message/code across the cause chain and
// match the phrasings iOS/Android actually use (note: "could not be found" does
// NOT contain the substring "not found").
function isMissingEvent(e) {
  let text = "";
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.message) text += " " + cur.message;
    if (cur.code) text += " " + cur.code;
    cur = cur.cause;
  }
  text = text.toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("could not be found") ||
    text.includes("no event") ||
    text.includes("does not exist") ||
    text.includes("doesn't exist") ||
    text.includes("invalid")
  );
}

// Keep the in-memory store coherent after a calendar bookkeeping write (which
// deliberately doesn't emit).
function reflectCalendarFields(sk, fields) {
  try {
    const cur = useInspectionStore.getState().getById(sk);
    if (cur) useInspectionStore.getState().update({ ...cur, ...fields });
  } catch (_) {}
}

// ─── permission + calendar listing (also used by the Settings screen) ────────

export async function getCalendarPermissionStatus() {
  try {
    const p = await Calendar.getCalendarPermissionsAsync();
    return p?.status ?? "undetermined";
  } catch (e) {
    logError(e, "calendarSync.getCalendarPermissionStatus");
    return "undetermined";
  }
}

export async function requestCalendarAccess() {
  try {
    const cur = await Calendar.getCalendarPermissionsAsync();
    if (cur.status === "granted") return true;
    if (cur.canAskAgain) {
      const next = await Calendar.requestCalendarPermissionsAsync();
      return next.status === "granted";
    }
    return false;
  } catch (e) {
    logError(e, "calendarSync.requestCalendarAccess");
    return false;
  }
}

// Writable calendars only (we never offer a read-only calendar). Shape is
// trimmed for the picker.
export async function listWritableCalendars() {
  if (!(await requestCalendarAccess())) return { granted: false, calendars: [] };
  try {
    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const calendars = (cals || [])
      .filter((c) => c.allowsModifications)
      .map((c) => ({
        id: c.id,
        title: c.title,
        color: c.color,
        sourceName: c.source?.name || c.source?.type || "",
        sourceType: c.source?.type || "",
      }));
    return { granted: true, calendars };
  } catch (e) {
    logError(e, "calendarSync.listWritableCalendars");
    return { granted: true, calendars: [] };
  }
}

async function calendarExists(calendarId) {
  try {
    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    return (cals || []).some((c) => c.id === calendarId);
  } catch (_) {
    return false;
  }
}

// True if the user's chosen calendar is still present on the device (the
// Settings screen prompts a re-pick when this is false).
export async function isChosenCalendarPresent() {
  const cfg = getConfig();
  if (!cfg.calendarId) return true;
  return calendarExists(cfg.calendarId);
}

// ─── PUSH (Zuba → calendar) ──────────────────────────────────────────────────

async function createEventForInspection(sk, insp, cfg) {
  const input = inspectionToEventInput(insp);
  const newId = await Calendar.createEventAsync(cfg.calendarId, input);
  const snap = snapshotFromInspection(insp);
  await setInspectionCalendarFields(sk, {
    eventId: newId,
    ownerDeviceId: cfg.deviceId,
    snapshot: snap,
    propagate: true,
  });
  reflectCalendarFields(sk, {
    CalendarEventId: newId,
    CalendarOwnerDeviceId: cfg.deviceId,
    CalendarSnapshot: JSON.stringify(snap),
  });
}

async function updateEventForInspection(sk, insp, eventId, cfg) {
  const input = inspectionToEventInput(insp);
  try {
    await Calendar.updateEventAsync(eventId, input);
  } catch (e) {
    if (isMissingEvent(e)) {
      // The event was deleted on the calendar — back-fill a fresh one.
      await createEventForInspection(sk, insp, cfg);
      return;
    }
    throw e;
  }
  const snap = snapshotFromInspection(insp);
  await setInspectionCalendarFields(sk, {
    eventId,
    ownerDeviceId: cfg.deviceId,
    snapshot: snap,
    propagate: false,
  });
  reflectCalendarFields(sk, {
    CalendarEventId: eventId,
    CalendarOwnerDeviceId: cfg.deviceId,
    CalendarSnapshot: JSON.stringify(snap),
  });
}

async function removeEventForInspection(sk, eventId) {
  try {
    await Calendar.deleteEventAsync(eventId);
  } catch (e) {
    if (!isMissingEvent(e)) logError(e, `calendarSync.removeEvent sk=${sk}`);
  }
  await setInspectionCalendarFields(sk, {
    eventId: null,
    ownerDeviceId: null,
    snapshot: null,
    propagate: true,
  });
  reflectCalendarFields(sk, {
    CalendarEventId: null,
    CalendarOwnerDeviceId: null,
    CalendarSnapshot: null,
  });
}

// INSERT + UPDATE bus handler.
async function handleUpsert(insp) {
  try {
    if (applyingRemote) return;
    const cfg = getConfig();
    if (!configured(cfg) || !cfg.push) return;
    const sk = insp?.InspectionSk;
    if (!sk) return;

    const eventId = insp.CalendarEventId || null;
    const owner = insp.CalendarOwnerDeviceId || null;
    const ownedByMe = !owner || owner === cfg.deviceId;

    // Terminal → the appointment is no longer on the active schedule; mirror
    // notifications' cancel-on-close by removing the calendar event. CANCELLED
    // counts (e.g. a client texting "X" to their reminder): the event must come
    // off the calendar, not linger to be re-imported as a duplicate.
    const terminal =
      insp.Status === "CLOSED" ||
      insp.Status === "CANCELLED" ||
      insp._deleted === 1 ||
      insp._deleted === true;
    if (terminal) {
      if (eventId && ownedByMe) {
        if (!(await requestCalendarAccess())) return;
        await removeEventForInspection(sk, eventId);
      }
      return;
    }

    if (!insp.ScheduledAt) return; // needs a time to place on a calendar
    if (!ownedByMe) return; // another Zuba device manages this event

    if (!(await requestCalendarAccess())) return;
    if (!(await calendarExists(cfg.calendarId))) return;

    if (!eventId) {
      await createEventForInspection(sk, insp, cfg);
    } else {
      const desired = snapshotFromInspection(insp);
      const stored = parseSnapshot(insp.CalendarSnapshot);
      if (stored && sameContent(stored, desired)) return; // no-op (loop guard)
      await updateEventForInspection(sk, insp, eventId, cfg);
    }
  } catch (e) {
    logError(e, `calendarSync.handleUpsert sk=${insp?.InspectionSk ?? "?"}`);
  }
}

// DELETE bus handler — payload carries only { InspectionSk }.
async function handleDelete(payload) {
  try {
    if (applyingRemote) return;
    const cfg = getConfig();
    if (!configured(cfg) || !cfg.push) return;
    const sk = payload?.InspectionSk;
    if (!sk) return;
    const row = await getInspectionById(sk);
    const eventId = row?.CalendarEventId;
    const owner = row?.CalendarOwnerDeviceId;
    if (eventId && (!owner || owner === cfg.deviceId)) {
      if (!(await requestCalendarAccess())) return;
      await removeEventForInspection(sk, eventId);
    }
  } catch (e) {
    logError(e, `calendarSync.handleDelete sk=${payload?.InspectionSk ?? "?"}`);
  }
}

// Sweep active inspections that aren't linked yet and create events for them.
// Used when the user first enables sync (existing inspections were created
// before the bus handler was live) and by "Re-sync now".
async function pushSweep(cfg) {
  if (!cfg.push) return;
  const list = useInspectionStore.getState().getSorted();
  for (const insp of list) {
    if (!insp || insp.CalendarEventId || !insp.ScheduledAt) continue;
    // eslint-disable-next-line no-await-in-loop
    await handleUpsert(insp);
  }
}

// ─── PULL (calendar → Zuba) ──────────────────────────────────────────────────

// newest-wins: true → calendar should overwrite the inspection.
function calendarWins(ev, link) {
  const evMod = ev.lastModifiedDate
    ? new Date(ev.lastModifiedDate).getTime()
    : null;
  const inspMod =
    link._lastChangedAt != null ? Number(link._lastChangedAt) : null;
  if (evMod != null && inspMod != null) return evMod >= inspMod; // tie → calendar
  return true; // Android (no event timestamp) / unknown → calendar wins
}

// Map a calendar event onto an existing inspection when the calendar WINS
// (newest-wins). Phone/email only fill empties; the ADDRESS is two-way — a
// changed, non-empty location is an intentional overwrite and flows through.
async function applyEventToInspection(sk, ev, cfg) {
  const cur = await getInspectionById(sk);
  if (!cur) return;
  // We pull contact info out of the notes but deliberately do NOT map the notes
  // body onto Summary — Summary is inspection/report content, not scheduling
  // notes. A dedicated customer-notes field is V2. (cur.Summary is preserved.)
  const { phone, email } = extractContact(ev.notes || "");
  const merged = {
    ...cur,
    FullName: stripToken(ev.title) || cur.FullName || null,
    // Phone/email only FILL empties — never clobber a value typed in-app.
    Phone: cur.Phone || phone || null,
    Email: cur.Email || email || null,
    ScheduledAt: toIso(ev.startDate) || cur.ScheduledAt,
  };

  // Address is TWO-WAY. We're on the calendar-wins branch (the event is newer
  // than the inspection per newest-wins), so a changed location is an intentional
  // overwrite — re-geocode it into the structured fields exactly like on import.
  // Guards: only when the location ACTUALLY changed vs the last snapshot (so a
  // time-only edit doesn't needlessly re-geocode / re-snap), and only when it's
  // non-empty (a cleared calendar location must not wipe an entered address).
  const rawLoc = (ev.location || "").trim();
  const prevLoc = (parseSnapshot(cur.CalendarSnapshot)?.location || "").trim();
  if (rawLoc && rawLoc !== prevLoc) {
    const addr = await resolveEventAddress(rawLoc);
    merged.AddressLine1 = addr.line1;
    merged.City = addr.city;
    merged.State = addr.state;
    merged.ZipCode = addr.zip;
    merged.Latitude = addr.lat;
    merged.Longitude = addr.lng;
  }

  applyingRemote = true;
  let updated = null;
  try {
    updated = await updateInspection(sk, merged);
  } finally {
    applyingRemote = false;
  }
  const snap = snapshotFromEvent(ev);
  await setInspectionCalendarFields(sk, {
    eventId: ev.id,
    ownerDeviceId: cfg.deviceId,
    snapshot: snap,
    propagate: false,
  });
  if (updated) {
    useInspectionStore.getState().update({
      ...updated,
      CalendarEventId: ev.id,
      CalendarOwnerDeviceId: cfg.deviceId,
      CalendarSnapshot: JSON.stringify(snap),
    });
  }
}

// Bring the calendar event back in line with a newer inspection (resolves the
// "inspection wins" branch without waiting for the next in-app edit).
async function reconcileEventToInspection(sk, eventId, cfg) {
  const cur = await getInspectionById(sk);
  if (!cur) return;
  await updateEventForInspection(sk, cur, eventId, cfg);
}

// Create a brand-new inspection from a tagged calendar event.
async function importEventAsInspection(ev, cfg) {
  const userSk = useSettingsStore.getState()?.userSk;
  if (!userSk) return;
  const settings = useSettingsStore.getState();
  // Extract follow-up contact info; the notes body itself is NOT mapped to
  // Summary (report content) — a dedicated customer-notes field is V2.
  const { phone, email, emails } = extractContact(ev.notes || "");
  // Round-trip the (possibly messy) calendar location through the OS geocoder so
  // it lands in canonical structured fields regardless of how it was entered;
  // also captures lat/lng so the imported inspection shows on the map. Falls back
  // to the regex parse on any geocode failure.
  const addr = await resolveEventAddress(ev.location || "");
  const data = {
    UserSk: userSk,
    FullName: stripToken(ev.title) || "Inspection",
    AddressLine1: addr.line1,
    City: addr.city,
    State: addr.state,
    ZipCode: addr.zip,
    Latitude: addr.lat,
    Longitude: addr.lng,
    Phone: phone,
    Email: email,
    // Every email found gets the report; the first is the invoice/payer default —
    // mirrors the in-app recipient model ({ report:[], invoice:[] }). Left unset
    // (→ default '[]') when the notes carried no email.
    ReportRecipients:
      emails && emails.length
        ? JSON.stringify({ report: emails, invoice: [emails[0]] })
        : undefined,
    ScheduledAt: toIso(ev.startDate),
    HasApptReminder: settings?.apptReminderSmsEnabled ? 1 : 0,
  };
  applyingRemote = true;
  let inserted = null;
  try {
    inserted = await insertInspection(data);
  } finally {
    applyingRemote = false;
  }
  if (!inserted) return;
  const snap = snapshotFromEvent(ev);
  await setInspectionCalendarFields(inserted.InspectionSk, {
    eventId: ev.id,
    ownerDeviceId: cfg.deviceId,
    snapshot: snap,
    propagate: true,
  });
  useInspectionStore.getState().add({
    ...inserted,
    CalendarEventId: ev.id,
    CalendarOwnerDeviceId: cfg.deviceId,
    CalendarSnapshot: JSON.stringify(snap),
  });
}

// The poll. Safe to call repeatedly (on app foreground / focus); self-gates.
export async function runPull() {
  try {
    const cfg = getConfig();
    // ── TEMP DIAGNOSTIC (remove once calendar pull is verified) ──
    if (!configured(cfg) || !cfg.pull) {
      console.log(
        `[calendar] runPull skip — enabled=${cfg.enabled} pull=${cfg.pull} ` +
          `calendarId=${cfg.calendarId ? "set" : "null"} deviceId=${cfg.deviceId ? "set" : "null"}`,
      );
      return;
    }
    if (!(await requestCalendarAccess())) {
      console.log("[calendar] runPull skip — calendar permission not granted");
      return;
    }
    if (!(await calendarExists(cfg.calendarId))) {
      console.log(
        `[calendar] runPull skip — chosen calendar not on device (id=${cfg.calendarId})`,
      );
      return;
    }

    const now = Date.now();
    const windowStart = new Date(now - WINDOW_PAST_MS);
    const windowEnd = new Date(now + WINDOW_FUTURE_MS);
    const events = await Calendar.getEventsAsync(
      [cfg.calendarId],
      windowStart,
      windowEnd,
    );
    console.log(
      `[calendar] runPull — fetched ${events?.length ?? 0} event(s) from calendar ${cfg.calendarId}`,
    );

    // Everything this device already owns in the chosen calendar.
    const links = await getActiveCalendarLinks(cfg.deviceId);
    const byEventId = new Map(
      links.map((l) => [l.CalendarEventId, l]),
    );

    // Events we own whose inspection has gone terminal (cancelled/completed/
    // deleted). Matched here so a stale tagged event is cleaned up and — crucially
    // — never re-imported as a duplicate (e.g. after a text-reply "X" cancel).
    const retired = await getRetiredCalendarLinks(cfg.deviceId);
    const retiredByEventId = new Map(retired.map((l) => [l.CalendarEventId, l]));

    const seen = new Set();
    let nKnown = 0;
    let nTagged = 0;
    let nImported = 0;
    let nUntagged = 0;
    let nAllDay = 0;
    let nRetired = 0;
    for (const ev of events || []) {
      if (ev.allDay) {
        nAllDay++;
        continue; // an inspection needs a time
      }
      const known = byEventId.get(ev.id);

      if (known) {
        nKnown++;
        seen.add(ev.id);
        const evSnap = snapshotFromEvent(ev);
        const stored = parseSnapshot(known.CalendarSnapshot);
        if (stored && sameContent(stored, evSnap)) continue; // unchanged
        // eslint-disable-next-line no-await-in-loop
        if (calendarWins(ev, known)) {
          // eslint-disable-next-line no-await-in-loop
          await applyEventToInspection(known.InspectionSk, ev, cfg);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await reconcileEventToInspection(known.InspectionSk, ev.id, cfg);
        }
        continue;
      }

      // Owned by a terminal (cancelled/completed/deleted) inspection → the
      // appointment is off; drop the stale event and DON'T re-import it. This is
      // what stops a text-reply cancel from spawning a duplicate inspection.
      const retiredLink = retiredByEventId.get(ev.id);
      if (retiredLink) {
        seen.add(ev.id);
        // eslint-disable-next-line no-await-in-loop
        await removeEventForInspection(retiredLink.InspectionSk, ev.id);
        nRetired++;
        continue;
      }

      // Unknown to us → only import if it's tagged for Zuba.
      if (hasToken(ev.title) || hasToken(ev.notes)) {
        nTagged++;
        seen.add(ev.id);
        // eslint-disable-next-line no-await-in-loop
        await importEventAsInspection(ev, cfg);
        nImported++;
      } else {
        nUntagged++;
      }
    }
    console.log(
      `[calendar] runPull summary — known=${nKnown} tagged=${nTagged} ` +
        `imported=${nImported} retired(removed)=${nRetired} ` +
        `untagged(ignored)=${nUntagged} allDay(skipped)=${nAllDay}`,
    );

    // Owned links whose event vanished from the window → deleted on the
    // calendar → soft-delete the inspection. Only conclude deletion for links
    // whose time falls INSIDE the scanned window (an appt beyond the window is
    // simply out of range, not deleted).
    const startMs = windowStart.getTime();
    const endMs = windowEnd.getTime();
    let nDeleted = 0;
    for (const l of links) {
      if (seen.has(l.CalendarEventId)) continue;
      if (!l.ScheduledAt) continue;
      const t = new Date(l.ScheduledAt).getTime();
      if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
      // Don't conclude a calendar-side deletion for a row with local pending
      // changes (Synced=0): the user just restored/edited it in-app, so a missing
      // event is a link awaiting (re)creation, not a user calendar deletion. Real
      // calendar-side deletes land on settled (Synced=1) rows and are caught on a
      // later pull. This closes the race where a dangling link could soft-delete a
      // just-restored inspection before its recreate lands.
      if (l.Synced === 0) continue;
      applyingRemote = true;
      try {
        // eslint-disable-next-line no-await-in-loop
        await softDeleteInspection(l.InspectionSk);
      } finally {
        applyingRemote = false;
      }
      useInspectionStore.getState().remove(l.InspectionSk);
      nDeleted++;
    }

    // Only record when the pull actually changed something — this runs on every
    // app foreground, so a quiet run would just be noise.
    if (nImported > 0 || nDeleted > 0 || nRetired > 0) {
      logEvent("calendar.synced", {
        imported: nImported,
        deleted: nDeleted,
        retired: nRetired,
        known: nKnown,
      });
    }
  } catch (e) {
    logError(e, "calendarSync.runPull");
  }
}

// Push existing inspections up, then pull tagged events down. Used by the
// "Re-sync now" button and right after the user enables sync / picks a calendar.
export async function resyncNow() {
  try {
    const cfg = getConfig();
    if (!configured(cfg)) return;
    if (!(await requestCalendarAccess())) return;
    await pushSweep(cfg);
    await runPull();
  } catch (e) {
    logError(e, "calendarSync.resyncNow");
  }
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

// Subscribe the push handlers to the db event bus. Mount once from
// app/_layout.jsx (handlers self-gate on config, so eager mounting is safe).
// Returns an unsubscribe fn.
export function startCalendarSync() {
  const unsubIns = subscribe(DB_EVENTS.INSPECTION_INSERTED, handleUpsert);
  const unsubUpd = subscribe(DB_EVENTS.INSPECTION_UPDATED, handleUpsert);
  const unsubDel = subscribe(DB_EVENTS.INSPECTION_DELETED, handleDelete);
  return () => {
    unsubIns();
    unsubUpd();
    unsubDel();
  };
}
