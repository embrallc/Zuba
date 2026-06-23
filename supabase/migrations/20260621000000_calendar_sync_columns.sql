-- Two-way calendar sync bookkeeping on inspections (device-editable, mirrors
-- the home-grown sync exactly like report_recipients).
--
-- calendar_event_id         — the owner device's LOCAL system-calendar event id
--                             this inspection maps to. Device-local in nature
--                             (event ids differ per device); other devices store
--                             it but ignore it, gating on the owner id below.
-- calendar_owner_device_id  — which Zuba device manages this inspection's
--                             calendar event (single-writer guard so a second
--                             device never creates a duplicate event).
-- calendar_snapshot         — last-synced {title,start,end,location,notes,
--                             lastModified} the engine diffs against to detect
--                             calendar-side changes, resolve conflicts
--                             (newest-wins), and short-circuit push/pull loops.
--
-- All additive + nullable, so existing rows backfill to NULL and older app
-- builds (which don't read these) keep working. RLS on inspections already
-- scopes these; no new policies needed.

ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS calendar_event_id        TEXT,
  ADD COLUMN IF NOT EXISTS calendar_owner_device_id TEXT,
  ADD COLUMN IF NOT EXISTS calendar_snapshot        JSONB;
