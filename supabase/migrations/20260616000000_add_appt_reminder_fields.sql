-- Client appointment-reminder fields on inspections.
--
-- has_appt_reminder    — per-inspection opt-in for the day-before client SMS
--                        reminder. Seeded from the org/device "Text appointment
--                        reminder" setting at create time; overridable in Add/Edit.
-- appt_reminder_status — send tracker the reminder job flips PENDING -> SENT so a
--                        reminder is texted at most once. New rows start PENDING.
--
-- Both are additive with defaults, so existing rows are backfilled automatically
-- and the change stays backward compatible with older app builds (which simply
-- ignore the columns).

ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS has_appt_reminder BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS appt_reminder_status TEXT NOT NULL DEFAULT 'PENDING';

-- Constrain the status to the two known states. Guarded so re-running the
-- migration (or applying after a manual add) doesn't error on a dup constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inspections_appt_reminder_status_check'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_appt_reminder_status_check
      CHECK (appt_reminder_status IN ('PENDING', 'SENT'));
  END IF;
END $$;
