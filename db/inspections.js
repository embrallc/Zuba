import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
import { DB_EVENTS, emit } from "./events";
import { db } from "./index";
import { logError } from "./logs";

export async function getAllInspections() {
  try {
    return await db.getAllAsync(
      `SELECT * FROM Inspections WHERE _deleted = 0 ORDER BY ScheduledAt ASC`,
    );
  } catch (e) {
    logError(e, "db/inspections.getAllInspections");
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
