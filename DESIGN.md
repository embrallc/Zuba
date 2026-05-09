# ClientManagement App — Design Document

## Overview

An app for professional inspectors (home, roof, etc.) to conduct inspections in the field, capture photos and notes, generate a PDF summary, and send it to the client via email.

**Pricing:**

- $19.99/month base (in-app purchase via App Store / Google Play)
- $5.99/month optional cloud storage add-on
- Users remain logged in until payment fails, at which point they are kicked out

---

## Data Model

### AppLogs

Internal error/event logging.

| Column     | Type    | Notes |
| ---------- | ------- | ----- |
| LogSk      | TEXT PK |       |
| Level      | TEXT    |       |
| Message    | TEXT    |       |
| StackTrace | TEXT    |       |
| Context    | TEXT    |       |
| CreatedAt  | INTEGER |       |

---

### Users

One user per device/install. Tracked with a fixed SK for cloud storage separation.

| Column          | Type        | Notes             |
| --------------- | ----------- | ----------------- |
| UserSk          | TEXT PK     |                   |
| UserId          | TEXT UNIQUE |                   |
| fname           | TEXT        |                   |
| lname           | TEXT        |                   |
| OrgSk           | TEXT FK     | → Organizations   |
| Role            | TEXT        | 'admin' or 'user' |
| \_version       | INTEGER     | default 1         |
| \_lastChangedAt | INTEGER     |                   |
| \_deleted       | BOOLEAN     | default 0         |

---

### Inspections

One row per inspection. Holds client contact info, address, scheduled time, and summary.

| Column          | Type    | Notes                                                  |
| --------------- | ------- | ------------------------------------------------------ |
| InspectionSk    | TEXT PK |                                                        |
| UserSk          | TEXT FK | → Users                                                |
| FullName        | TEXT    | Client full name                                       |
| Summary         | TEXT    | Overall inspection summary                             |
| AddressLine1    | TEXT    |                                                        |
| AddressLine2    | TEXT    |                                                        |
| City            | TEXT    |                                                        |
| State           | TEXT    |                                                        |
| ZipCode         | TEXT    |                                                        |
| ScheduledAt     | TEXT    | ISO datetime                                           |
| Phone           | TEXT    |                                                        |
| Email           | TEXT    |                                                        |
| Longitude       | REAL    | Auto-captured when Address1+City+State+Zip are present |
| Latitude        | REAL    | Auto-captured when Address1+City+State+Zip are present |
| \_version       | INTEGER | default 1                                              |
| \_lastChangedAt | INTEGER |                                                        |
| \_deleted       | BOOLEAN | default 0                                              |

---

### InspectionDescription

Groups of photos/notes within an inspection. One inspection has many descriptions (sections).

| Column                  | Type    | Notes                                    |
| ----------------------- | ------- | ---------------------------------------- |
| InspectionDescriptionSk | TEXT PK |                                          |
| InspectionSk            | TEXT FK | → Inspections                            |
| Description             | TEXT    | Section description written by inspector |
| \_version               | INTEGER | default 1                                |
| \_lastChangedAt         | INTEGER |                                          |
| \_deleted               | BOOLEAN | default 0                                |

---

### InspectionDetail

Individual photos within a description section. One description has many details.

| Column                  | Type    | Notes                                 |
| ----------------------- | ------- | ------------------------------------- |
| InspectionDetailSk      | TEXT PK |                                       |
| InspectionDescriptionSk | TEXT FK | → InspectionDescription               |
| PictureURI              | TEXT    | Local file path on device             |
| PictureNote             | TEXT    | Optional note for this specific photo |
| \_version               | INTEGER | default 1                             |
| \_lastChangedAt         | INTEGER |                                       |
| \_deleted               | BOOLEAN | default 0                             |

---

## Architecture Decisions

### Theme

- All styling must import from `@theme/` (alias for `theme/index.js`)
- Never use hardcoded colors, font sizes, spacing, radii, or shadow values — always reference the theme
- Import via: `import { theme } from '@theme'`
- Available tokens:
  - `theme.colors` — mainBackground, cardBackground, input, icon, primary, text, textSubtle, textFine
  - `theme.typography` — h1–h4, body, bodyBold, label, labelSmall, caption, overline
  - `theme.spacing` — xs(4), s(8), m(16), l(24), xl(32), xxl(48)
  - `theme.layout` — borderRadius, borderWidth, iconSize, avatarSize, hitSlop, opacity
  - `theme.shadows` — light, medium, dark (platform-aware iOS/Android)

### Local Database

- **SQLite** via `expo-sqlite` (~16.0.x)
- All persistent data lives in SQLite on-device
- Schema defined in the Data Model section below
- Zustand stores serve as the in-memory layer on top — SQLite is the source of truth, stores mirror it for fast UI access
- Database initialized at app startup; migrations handled via versioned schema scripts

---

### State Management — Zustand Stores

Stores are split by concern. Do not consolidate into one global store.

| Store                | Responsibility                                                          |
| -------------------- | ----------------------------------------------------------------------- |
| `useInspectionStore` | In-memory inspection list, O(1) add/update/delete, sorted order         |
| `useSettingsStore`   | User preferences (show weekends, cloud storage toggle, future settings) |
| `useMapStore`        | Map open/close state, which inspections to plot, active date filter     |
| `useUIStore`         | Modal open/close state, active inspection being edited, loading flags   |

> Additional stores added here as new concerns are identified.

---

## Navigation Structure

- **Root Stack** (app/\_layout.jsx)
  - `(tabs)` — main tab navigator (header hidden)
  - `addinspection` — AddInspection modal (header hidden)
  - `settings` — Global Settings panel (slides in from right)

---

## Screens & Features

---

### Tab 1 — List View (Default/Home Tab)

**Purpose:** Master list of all inspections.

**Header Bar:**

- Search bar — filters cards by: FullName, AddressLine1, AddressLine2, City, State, ZipCode
- Map icon — opens the in-app full map (slides in from the right), plotting ALL inspections

**Inspection Cards:**

- Primary header: FullName + ScheduledAt (date & time)
- Secondary: Full address in label text
- Sidebar color indicator:
  - Orange = inspection info incomplete
  - Green = all relevant fields filled out
- Action icons on each card:
  - SMS icon → opens native text message to client Phone
  - Phone icon → opens native phone call to client Phone
  - Navigation icon → opens native maps app with address
  - Map pin icon → opens in-app map with just that inspection pinned + user's blue dot location
- Tapping the card → opens AddInspection modal in **Edit mode**

**Performance:**

- In-memory lookup table (e.g. Zustand store) stays in sync with SQLite
- Adding a new inspection inserts into the store in O(1) — no re-query of full list
- List sorted by ScheduledAt ASC

---

### In-App Map

**Triggered two ways:**

1. Global map icon in List View header → plots ALL inspections
2. Map icon on individual card → plots only that inspection

**Features:**

- Blue dot for user's current location
- Pins for each plotted inspection
- When opened globally:
  - Date filter header with toggle buttons: "All" or one specific date at a time
  - Filters which inspection pins are displayed on the map
- Slides in from the right (shared component used in both contexts)

---

### Tab 2 — Week View

**Purpose:** Calendar week view showing inspections by day and time.

**Layout:**

- Default columns: Monday – Friday
- Optional toggle to show Saturday and Sunday
- Scrollable time grid: 5:00 AM – 9:00 PM
- Default scroll position on entry: 9:00 AM – 5:00 PM visible

**Inspection display:**

- Compressed inspection card shown at its ScheduledAt time slot
- Clicking a compressed card → opens AddInspection modal in **Edit mode**

**Adding a new inspection:**

- Tap empty space in the time grid
- Opens AddInspection modal in **Add mode**
- Pre-populates the selected day and snaps time to nearest half hour
  - e.g. tap at 9:22 AM → pre-fills 9:00 AM

---

### Tab 3 — Month View

**Purpose:** High-level monthly calendar overview.

**Layout:**

- Scrollable month grid
- Each day with an inspection shows a small colored circle with client initials
  - Initials = first letter of each word in FullName (e.g. "John Smith" → "JS")

**Interaction:**

- Tapping a day with inspections → shows a popup with:
  - FullName
  - Full address
  - Date and time

---

### Global Settings Panel

**Purpose:** User-configurable app preferences.

**Navigation:**

- Accessible from the root layout stack (available across all tabs)
- Slides in from the right as a stack screen

**Display:**

- List of toggle switches and options

**Current Settings:**

- Show Saturday & Sunday in Week View (toggle, default off)
- Subscribe to Cloud Storage — links to the $5.99/month in-app purchase upgrade (toggle/button)

**TBD Settings (add as we go):**

- Additional preferences to be defined

---

### AddInspection Modal

**Purpose:** Add a new inspection or edit an existing one. Used across all three tabs.

**Modes:**

- Add mode: all fields blank except ScheduledAt pre-filled with current date/time
- Edit mode: all fields pre-populated from existing inspection record

**Fields:**

- FullName
- Phone
- Email
- AddressLine1
- AddressLine2
- City
- State
- ZipCode
- ScheduledAt — Date picker (date) + time picker wheel (hours & minutes)
  - Date and time are always pre-populated; user cannot clear them completely
- Summary (overall inspection notes)

**Geo-capture:**

- When AddressLine1 + City + State + ZipCode are all present, automatically attempt to geocode and store Longitude/Latitude

**Inspection Sections (InspectionDescription + InspectionDetail):**

- Inspector can add multiple description sections
- Each section has:
  - A text description
  - Multiple photos, each with an optional note
- Photos taken in-app or selected from camera roll

**Bottom action:**

- Save button

---

## Output & Delivery

- Once an inspection is complete, auto-generate a PDF containing:
  - Client info
  - Overall summary
  - All description sections with their photos and notes
- PDF attached to a pre-composed email ready to send to client Email address

---

## Auth & Subscription

- Users log in once and remain logged in persistently
- If monthly payment fails → user is kicked out of the app
- Subscription managed via App Store (Apple) and Google Play (Android) in-app purchase APIs

---

## Open Questions / TBD

- [ ] Organizations table schema (referenced by Users.OrgSk but not yet defined)
- [ ] Cloud sync strategy for the $5.99 add-on tier (what gets synced, conflict resolution)
- [ ] Auth provider selection (e.g. Supabase, Firebase, custom)
- [ ] Offline behavior when geocoding is unavailable
- [ ] Google Maps API key (required for Android map support — added as empty string placeholder in app.json)
- [ ] RevenueCat Android API key (required for Google Play subscriptions — placeholder in app.json)

## Decided

- **PDF generation** → `expo-print` (HTML to PDF) + `expo-sharing` + `expo-mail-composer`
- **Map** → `react-native-maps`
- **Subscriptions / IAP** → `react-native-purchases` (RevenueCat) — handles cross-platform receipt validation and entitlement management for both App Store and Google Play
