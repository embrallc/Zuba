# Calendar Integration Plan — Zuba (two-way Apple/Google calendar sync)

## Context

Inspectors want their schedule in their own Apple/Google calendar, and — critically — **two-way** sync: an assistant who only has access to the inspector's Google Calendar can add/edit/cancel appointments and have them flow into Zuba (and the reverse), so the inspector and assistant never double-book. This is **local, on-device only**: `expo-calendar` (already installed, `~15.0.8`) reads/writes the device system calendar (EventKit on iOS, CalendarProvider on Android); the OS syncs that to the user's Google/iCloud accounts. **No Google/Apple cloud APIs, no Edge Functions, no server work.**

## Locked decisions (from planning Q&A)

- **Full two-way sync** from day one (calendar ↔ Zuba).
- **Pull source = a calendar the inspector PICKS, classified by a `#zuba` marker.** The picked calendar (must be *account-backed* — e.g. a Google calendar they share with the assistant; a local-only calendar won't reach Google) only scopes WHERE we scan; we never read their other calendars. WITHIN it, **only events whose title or notes contain the literal token `#zuba` (case-insensitive) are treated as inspections** — so an inspector can keep other appointments in the same calendar without them leaking into Zuba. Zuba auto-stamps `#zuba` into the notes of events it creates; the assistant types `#zuba` on appointments they add (the picked calendar's description is pre-seeded with this instruction).
- **Marker = the literal string `#zuba`, case-insensitive, in title OR notes.** No dedicated calendar metadata field exists in expo-calendar (confirmed against SDK 54 docs: only `notes` is cross-platform writable; `url` is iOS-only; there is no `extendedProperties`/key-value field) — so a text token is the only portable signal. Membership-as-tag was rejected because a mixed-use calendar would import personal events as bogus inspections (over-sync is worse than under-sync).
- **Controls:** one master **Calendar Sync** toggle + a **calendar picker** (lists only writable calendars that actually exist) + two sub-toggles **Push inspections** / **Pull `#zuba` events** + a help note explaining the `#zuba` tagging convention (with a copy-the-instruction affordance for the assistant). Gating: only show/enable what exists; on iOS a Google calendar appears only if the Google account is added at the OS level — otherwise show a "connect Google in iOS Settings" hint instead of a dead toggle.
- **Deletes mirror both ways**, via soft-delete (recoverable from Archive).
- **Conflict rule = newest change wins.** iOS: compare event `lastModifiedDate` vs inspection `_lastChangedAt`. Android (no calendar timestamp) and ties → **calendar wins**.
- **Pulled event → inspection = best-effort map** (start→`ScheduledAt`, title→`FullName`, location→address). Phone/email are regexed out of the event notes into `Phone`/`Email` for follow-up. The notes BODY is intentionally NOT mapped to `Summary` (Summary = report content); a dedicated customer-notes field is **V2**.
- **No alarms** on calendar events (our `utils/notifications.js` owns reminders — avoid double pings).

## Key API realities (confirmed against SDK 54 docs)

- **No change-notification API** → calendar→Zuba is **poll + snapshot-diff**, triggered on app foreground (`AppState 'active'`) and My Day focus.
- **No stable cross-device event id** (no iCalUID/external id exposed) → match by the **device-local event id** stored on the inspection. Solid for the common case (one Zuba device + assistant on Google web); rare phone+tablet case uses a single-writer guard.
- **`lastModifiedDate`/`creationDate` are iOS-only** → Android change-detection is field-diff vs snapshot; conflict ties fall to "calendar wins."
- **`createCalendarAsync` under a Google source from the device is not guaranteed** → hence "always pick existing" (no programmatic create in v1).
- **No custom-metadata field on events** (only `notes` is cross-platform writable; `url` is iOS-only) → the inspection marker must be a text token (`#zuba`) carried in title/notes, matched case-insensitively.

## Architecture

Mirror the notifications integration: db writes emit on the bus ([db/events.js](db/events.js) — `INSPECTION_INSERTED/UPDATED/DELETED`); a new engine subscribes from [app/_layout.jsx](app/_layout.jsx) using the same `useEffect`+`subscribe` block already there (~L227-246 for notifications).

### Data model

**Per-inspection (synced — add to SQLite `Inspections` + cloud `inspections`, push/pull exactly like the recent `ReportRecipients` columns):**
- `CalendarEventId TEXT` — device-local event id this inspection maps to.
- `CalendarOwnerDeviceId TEXT` — which Zuba device owns the event (single-writer guard).
- `CalendarSnapshot TEXT` (JSON) — last-synced `{title,start,end,location,notes,lastModified}` for diff + conflict resolution + loop prevention.

**Per-device (AsyncStorage, NOT synced — the chosen calendar is device-local):** `{ enabled, push, pull, calendarId, sourceName, deviceId }`. `deviceId` = a UUID generated once via `expo-crypto.randomUUID()` + AsyncStorage (avoids adding `expo-application`).

### New files
- **`utils/calendarSync.js`** — the engine: permission/calendar gating, push handlers (bus-subscribed), the poll/pull scanner + diff, conflict resolution, event↔inspection mapping, dedup via `CalendarEventId`/`CalendarOwnerDeviceId`. Patterned on `utils/notifications.js` (bus-subscribed, permission-gated, idempotent).
- **`app/calendarsettings.jsx`** — Settings → "Calendar": master toggle, writable-calendar picker grouped by account, Push/Pull sub-toggles, "Re-sync now" button, permission/visibility hints, and a `#zuba` tagging help note (copyable instruction for the assistant).
- **`stores/useCalendarStore.js`** — device-local calendar config (or extend `useSettingsStore`).

### Touched files
- **[db/index.js](db/index.js)** — add the 3 columns to the `Inspections` CREATE + idempotent `ALTER TABLE … ADD COLUMN` patches (same pattern as `ReportRecipients`).
- **[utils/sync.js](utils/sync.js)** — map the 3 columns in `cloudInspectionToStoreObj`, `pushInspection`/`pushInspections`, `pullInspections`. Treat as **device-editable** (like `ReportRecipients`), NOT server-owned.
- **[db/inspections.js](db/inspections.js)** — add `setInspectionCalendarFields(sk, {...})`; reuse existing `insertInspection`/`updateInspection`/`softDeleteInspection`/`setInspectionStatus` for pull→Zuba writes so notifications + sync stay consistent.
- **[app/_layout.jsx](app/_layout.jsx)** — mount the calendar subscriber + foreground poll (mirror the notifications `useEffect`).
- **[app/settings.jsx](app/settings.jsx)** — add a "Calendar" nav row into `calendarsettings`.
- **[app.json](app.json)** — iOS `NSCalendarsFullAccessUsageDescription` (+ write-only fallback); Android `READ_CALENDAR`+`WRITE_CALENDAR`. **Native dev/EAS rebuild required.**
- **`reference_schema.md` memory** — append the 3 columns.

### Sync flows

**Push (Zuba → calendar)** — on bus events, if push enabled and this device owns/claims the event:
- INSERT → `createEventAsync(calendarId, map(inspection))` with `#zuba` appended to the event notes → store `CalendarEventId` + `CalendarOwnerDeviceId` + snapshot.
- UPDATE → `updateEventAsync(eventId, …)` (back-fill create if no id), keeping the `#zuba` marker in notes → refresh snapshot.
- DELETE (soft) → `deleteEventAsync(eventId)` → clear ids.

**Pull (calendar → Zuba)** — on foreground/focus poll, if pull enabled:
- `getEventsAsync([pickedCalendarId], windowStart, windowEnd)` over a rolling window (≈ −1 week … +6 months).
- **Classify:** an event qualifies only if its title or notes contains `#zuba` (case-insensitive) **OR** its id matches a stored `CalendarEventId` (one we already own). Everything else in the calendar is ignored.
- Per qualifying event: known `CalendarEventId` → diff vs snapshot → if calendar changed, apply conflict rule → `updateInspection` + refresh snapshot. Unknown id → `insertInspection(map(event))` + store id/snapshot. **Strip the `#zuba` token out of title/notes before mapping into `FullName`/`Summary`.**
- Known `CalendarEventId`s **absent** from the window (but still inside it) → deleted on calendar → **soft-delete** the inspection. An event that merely lost its `#zuba` token but still matches a stored id is NOT a delete — id ownership persists.

**Conflict:** newest wins via `lastModifiedDate` (iOS) vs `_lastChangedAt`; Android/tie → calendar wins. Snapshot equality short-circuits no-op writes → prevents push/pull ping-pong.

**Multi-device guard:** only the `CalendarOwnerDeviceId` device pushes updates/deletes for account-backed calendars; for purely-local calendars every device manages its own; a synced row arriving with `CalendarEventId` already set is not re-created.

## Edge cases
- Permission revoked → detect via `getCalendarPermissionsAsync`, banner "Calendar sync paused," keep the toggle + chosen calendar so the user can resume.
- Chosen calendar removed from device → not in `getCalendarsAsync` → prompt re-pick, pause.
- **Forgot the token, added it later** → fine: the next foreground poll re-scans the window, the event now matches `#zuba`, has no known `CalendarEventId`, and imports as a new inspection (grabbing its current field values). Under-sync until tagged is the intended safe failure — vs. over-syncing personal events.
- **Token typed into a non-inspection event** (e.g. `#zuba` in a lunch) → it will import; acceptable, rare, and recoverable via Archive.
- Recurring events → v1 imports in-window instances as individual inspections; Zuba does not author recurring events.
- All-day events → skipped (an inspection needs a time); optional hint.
- Loop prevention → snapshot equality check before any write in either direction.

## Verification
- Dev build with calendar permissions (native rebuild).
- iOS with iCloud + a Google account added at the OS level → picker lists both → pick the Google "Zuba" calendar.
- **Push:** create / reschedule / complete / delete an inspection → event appears / updates / deletes in Google Calendar (web) within OS sync latency.
- **Pull (assistant flow):** add an event **containing `#zuba`** to the picked calendar in Google web → foreground Zuba → inspection appears with mapped fields (token stripped); add an event **without** the token → confirm it is ignored; edit a tagged event → inspection updates; delete it → inspection moves to Archive.
- **Forgot-then-tag:** create an untagged event → confirm Zuba ignores it; edit it to add `#zuba` → foreground → it now imports.
- **Conflict:** change the same appointment in Zuba and Google before a sync → newest wins; confirm no ping-pong.
- **Multi-device:** same inspection on two Zuba devices → exactly one calendar event.
- **Gating:** device with no writable calendar → toggle disabled with hint.
