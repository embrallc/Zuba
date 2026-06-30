import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
import { DB_EVENTS, emit } from "./events";
import { db } from "./index";
import { logError } from "./logs";

// Active working set: not deleted and not completed. The CLOSED status is
// our "completed" terminal state (reusing the existing cloud CHECK value so
// no migration is needed). Completed rows are hidden from every list/calendar
// view but still live in SQLite + cloud so they can be restored from the
// Archive screen. The Status IS NULL guard covers legacy rows written before
// the column had a value.
export async function getAllInspections() {
  try {
    return await db.getAllAsync(
      `SELECT * FROM Inspections
       WHERE _deleted = 0 AND (Status IS NULL OR Status NOT IN ('CLOSED', 'CANCELLED'))
       ORDER BY ScheduledAt ASC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getAllInspections");
    throw e;
  }
}

// Single row by SK (any status), or null. Used by the Payments screen to label
// a payment_requests row with its client/address — completed inspections stay
// in SQLite so this resolves them too.
export async function getInspectionById(sk) {
  if (!sk) return null;
  try {
    return (
      (await db.getFirstAsync(`SELECT * FROM Inspections WHERE InspectionSk = ?`, [
        sk,
      ])) ?? null
    );
  } catch (e) {
    logError(e, `db/inspections.getInspectionById sk=${sk}`);
    return null;
  }
}

// Soft-deleted rows, for the Archive → Deleted restore screen.
export async function getDeletedInspections() {
  try {
    return await db.getAllAsync(
      `SELECT * FROM Inspections WHERE _deleted = 1 ORDER BY ScheduledAt ASC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getDeletedInspections");
    throw e;
  }
}

// Completed (CLOSED) rows that aren't deleted, for the Archive → Completed
// restore screen.
export async function getCompletedInspections() {
  try {
    return await db.getAllAsync(
      `SELECT * FROM Inspections
       WHERE _deleted = 0 AND Status = 'CLOSED'
       ORDER BY ScheduledAt ASC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getCompletedInspections");
    throw e;
  }
}

// Cancelled rows that aren't deleted, for the Archive → Cancelled restore
// screen. A client texting "X" to their day-before reminder sets this status
// server-side; the row arrives via Realtime/sync. Mirrors getCompletedInspections.
export async function getCancelledInspections() {
  try {
    return await db.getAllAsync(
      `SELECT * FROM Inspections
       WHERE _deleted = 0 AND Status = 'CANCELLED'
       ORDER BY ScheduledAt DESC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getCancelledInspections");
    throw e;
  }
}

// Count of cancellations the user hasn't viewed yet — those whose cancellation
// (_lastChangedAt bump) is newer than the last time they opened the Cancelled
// archive. Drives the unread badge over Settings + the Cancelled nav row.
export async function getUnviewedCancelledCount(sinceMs) {
  try {
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS n FROM Inspections
       WHERE _deleted = 0 AND Status = 'CANCELLED' AND _lastChangedAt > ?`,
      [Number(sinceMs) || 0],
    );
    return row?.n ?? 0;
  } catch (e) {
    logError(e, "db/inspections.getUnviewedCancelledCount");
    return 0;
  }
}

export async function insertInspection(data) {
  try {
    const sk = Crypto.randomUUID();
    const now = dayjs().valueOf();
    await db.runAsync(
      `INSERT INTO Inspections (
        InspectionSk, UserSk, FullName, Summary,
        AddressLine1, AddressLine2, City, State, ZipCode,
        ScheduledAt, Phone, Email, Longitude, Latitude,
        HasApptReminder, ApptReminderStatus, ReportRecipients,
        _version, _lastChangedAt, _deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)`,
      [
        sk,
        data.UserSk,
        data.FullName ?? null,
        data.Summary ?? null,
        data.AddressLine1 ?? null,
        data.AddressLine2 ?? null,
        data.City ?? null,
        data.State ?? null,
        data.ZipCode ?? null,
        data.ScheduledAt,
        data.Phone ?? null,
        data.Email ?? null,
        data.Longitude ?? null,
        data.Latitude ?? null,
        data.HasApptReminder ?? 0,
        data.ApptReminderStatus ?? "PENDING",
        data.ReportRecipients ?? "[]",
        now,
      ],
    );
    // Read back the full row so the store/event always get a complete,
    // column-shaped object (incl. PaymentState/ReportState/Paid/Status defaults)
    // rather than a hand-built subset that can drift from the schema.
    const inserted = await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    emit(DB_EVENTS.INSPECTION_INSERTED, inserted);
    return inserted;
  } catch (e) {
    logError(e, `db/inspections.insertInspection userSk=${data.UserSk}`);
    throw e;
  }
}

export async function updateInspection(sk, data) {
  try {
    const now = dayjs().valueOf();
    await db.runAsync(
      `UPDATE Inspections SET
        FullName = ?, Summary = ?,
        AddressLine1 = ?, AddressLine2 = ?,
        City = ?, State = ?, ZipCode = ?,
        ScheduledAt = ?, Phone = ?, Email = ?,
        Longitude = ?, Latitude = ?, HasApptReminder = ?,
        ReportRecipients = COALESCE(?, ReportRecipients),
        _version = _version + 1, _lastChangedAt = ?, Synced = 0
      WHERE InspectionSk = ?`,
      [
        data.FullName ?? null,
        data.Summary ?? null,
        data.AddressLine1 ?? null,
        data.AddressLine2 ?? null,
        data.City ?? null,
        data.State ?? null,
        data.ZipCode ?? null,
        data.ScheduledAt,
        data.Phone ?? null,
        data.Email ?? null,
        data.Longitude ?? null,
        data.Latitude ?? null,
        data.HasApptReminder ?? 0,
        data.ReportRecipients ?? null,
        now,
        sk,
      ],
    );
    // Read back the full row (not a spread of the edit-form fields) so the
    // returned object + the scheduler event carry every column —
    // Status/PaymentState/ReportState/Paid/_version — and never clobber them
    // when a caller pushes this into the store.
    const updated = await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    emit(DB_EVENTS.INSPECTION_UPDATED, updated);
    return updated;
  } catch (e) {
    logError(e, `db/inspections.updateInspection sk=${sk}`);
    throw e;
  }
}

export async function softDeleteInspection(sk) {
  try {
    const now = dayjs().valueOf();
    await db.runAsync(
      `UPDATE Inspections SET _deleted = 1, _lastChangedAt = ?, Synced = 0 WHERE InspectionSk = ?`,
      [now, sk],
    );
    emit(DB_EVENTS.INSPECTION_DELETED, { InspectionSk: sk });
  } catch (e) {
    logError(e, `db/inspections.softDeleteInspection sk=${sk}`);
    throw e;
  }
}

// Hard-delete an inspection and every record that hangs off it from local
// SQLite. Used by the "reassign away from me" path so the inspection leaves
// my Day/Week view immediately without waiting for the next syncAll cycle.
// Also blocks a subsequent push from accidentally undoing the cloud reassign
// by upserting the stale local row.
//
// FK constraints aren't ON DELETE CASCADE in the local schema, so children
// must go first.
export async function deleteInspectionLocal(sk) {
  try {
    await db.runAsync(`DELETE FROM InspectionForm WHERE InspectionSk = ?`, [sk]);
    await db.runAsync(`DELETE FROM SmsStatus WHERE InspectionSk = ?`, [sk]);
    await db.runAsync(`DELETE FROM Inspections WHERE InspectionSk = ?`, [sk]);
    emit(DB_EVENTS.INSPECTION_DELETED, { InspectionSk: sk });
  } catch (e) {
    logError(e, `db/inspections.deleteInspectionLocal sk=${sk}`);
    throw e;
  }
}

// Change an inspection's workflow Status (e.g. OPEN → CLOSED to complete it,
// or CLOSED → OPEN to reopen). Bumps _version + clears Synced so the change
// propagates on the next syncAll. Emits INSPECTION_UPDATED with the full row
// (read back from SQLite) so the notification scheduler can react — a CLOSED
// inspection has its reminder cancelled; reopening reschedules it.
export async function setInspectionStatus(sk, status) {
  try {
    const now = dayjs().valueOf();
    await db.runAsync(
      `UPDATE Inspections SET
        Status = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
      WHERE InspectionSk = ?`,
      [status, now, sk],
    );
    const updated = await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    if (updated) emit(DB_EVENTS.INSPECTION_UPDATED, updated);
    return updated;
  } catch (e) {
    logError(e, `db/inspections.setInspectionStatus sk=${sk} status=${status}`);
    throw e;
  }
}

// Optimistically reflect a payment state locally so the ribbon/badge updates
// immediately and survives complete → archive → reopen, before the
// authoritative cloud value syncs back. Deliberately does NOT bump
// _version/Synced (payment_state is server-owned — the webhook/EF set the real
// value, which wins on the next pull) and does NOT emit (no reschedule needed).
export async function setInspectionPaymentStateLocal(sk, state) {
  try {
    await db.runAsync(
      `UPDATE Inspections SET PaymentState = ? WHERE InspectionSk = ?`,
      [state, sk],
    );
    return await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
  } catch (e) {
    logError(e, `db/inspections.setInspectionPaymentStateLocal sk=${sk}`);
    return null;
  }
}

// Record where this device cached the last generated report PDF. Deliberately
// does NOT touch _version/Synced or emit events — the file is device-local
// metadata, not synced data, and must never trigger a cloud push or a
// notification reschedule.
export async function setInspectionLocalReport(sk, path, at) {
  try {
    await db.runAsync(
      `UPDATE Inspections SET LastReportPath = ?, LastReportAt = ? WHERE InspectionSk = ?`,
      [path ?? null, at ?? null, sk],
    );
    return await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
  } catch (e) {
    logError(e, `db/inspections.setInspectionLocalReport sk=${sk}`);
    throw e;
  }
}

// Write the calendar-sync bookkeeping columns for one inspection. Used by the
// calendar engine (utils/calendarSync.js) after it creates/updates/deletes the
// device calendar event, and after a pull links an event to an inspection.
//
// Deliberately does NOT emit a db event — emitting INSPECTION_UPDATED here would
// re-enter the calendar push handler and loop. When `propagate` is true we DO
// bump _version + clear Synced so the ownership/id reach the user's other
// devices (the single-writer guard); pure snapshot refreshes pass propagate:false
// to avoid cloud churn. `snapshot` may be an object (stringified) or null.
export async function setInspectionCalendarFields(
  sk,
  { eventId = null, ownerDeviceId = null, snapshot = null, propagate = false } = {},
) {
  try {
    const snapStr =
      snapshot == null
        ? null
        : typeof snapshot === "string"
          ? snapshot
          : JSON.stringify(snapshot);
    if (propagate) {
      const now = dayjs().valueOf();
      await db.runAsync(
        `UPDATE Inspections SET
          CalendarEventId = ?, CalendarOwnerDeviceId = ?, CalendarSnapshot = ?,
          _version = _version + 1, _lastChangedAt = ?, Synced = 0
         WHERE InspectionSk = ?`,
        [eventId, ownerDeviceId, snapStr, now, sk],
      );
    } else {
      await db.runAsync(
        `UPDATE Inspections SET
          CalendarEventId = ?, CalendarOwnerDeviceId = ?, CalendarSnapshot = ?
         WHERE InspectionSk = ?`,
        [eventId, ownerDeviceId, snapStr, sk],
      );
    }
    return await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
  } catch (e) {
    logError(e, `db/inspections.setInspectionCalendarFields sk=${sk}`);
    return null;
  }
}

// Active (not deleted, not completed) inspections this device owns a calendar
// event for. The pull reconciler uses this to find links whose event vanished
// from the calendar window (→ soft-delete the inspection).
export async function getActiveCalendarLinks(deviceId) {
  if (!deviceId) return [];
  try {
    return await db.getAllAsync(
      `SELECT InspectionSk, CalendarEventId, CalendarSnapshot, ScheduledAt,
              _lastChangedAt, Status
         FROM Inspections
        WHERE _deleted = 0 AND (Status IS NULL OR Status NOT IN ('CLOSED', 'CANCELLED'))
          AND CalendarOwnerDeviceId = ? AND CalendarEventId IS NOT NULL`,
      [deviceId],
    );
  } catch (e) {
    logError(e, "db/inspections.getActiveCalendarLinks");
    return [];
  }
}

// Un-delete a soft-deleted inspection (_deleted 1 → 0). Bumps _version +
// clears Synced. Emits INSPECTION_UPDATED with the full row so a future
// appointment gets its reminder rescheduled (the scheduler's own gates skip
// past appts and CLOSED rows).
export async function restoreInspection(sk) {
  try {
    const now = dayjs().valueOf();
    await db.runAsync(
      `UPDATE Inspections SET
        _deleted = 0, _version = _version + 1, _lastChangedAt = ?, Synced = 0
      WHERE InspectionSk = ?`,
      [now, sk],
    );
    const updated = await db.getFirstAsync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    if (updated) emit(DB_EVENTS.INSPECTION_UPDATED, updated);
    return updated;
  } catch (e) {
    logError(e, `db/inspections.restoreInspection sk=${sk}`);
    throw e;
  }
}
