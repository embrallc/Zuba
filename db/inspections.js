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
       WHERE _deleted = 0 AND (Status IS NULL OR Status != 'CLOSED')
       ORDER BY ScheduledAt ASC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getAllInspections");
    throw e;
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

export async function insertInspection(data) {
  try {
    const sk = Crypto.randomUUID();
    const now = dayjs().valueOf();
    await db.runAsync(
      `INSERT INTO Inspections (
        InspectionSk, UserSk, FullName, Summary,
        AddressLine1, AddressLine2, City, State, ZipCode,
        ScheduledAt, Phone, Email, Longitude, Latitude,
        _version, _lastChangedAt, _deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)`,
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
        now,
      ],
    );
    const inserted = {
      ...data,
      InspectionSk: sk,
      _version: 1,
      _lastChangedAt: now,
      _deleted: 0,
    };
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
        Longitude = ?, Latitude = ?,
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
        now,
        sk,
      ],
    );
    const updated = { ...data, InspectionSk: sk, _lastChangedAt: now };
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
    await db.runAsync(
      `DELETE FROM InspectionDetail WHERE InspectionDescriptionSk IN
       (SELECT InspectionDescriptionSk FROM InspectionDescription WHERE InspectionSk = ?)`,
      [sk],
    );
    await db.runAsync(
      `DELETE FROM InspectionDescription WHERE InspectionSk = ?`,
      [sk],
    );
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
