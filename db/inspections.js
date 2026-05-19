import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
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
    return {
      ...data,
      InspectionSk: sk,
      _version: 1,
      _lastChangedAt: now,
      _deleted: 0,
    };
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
    return { ...data, InspectionSk: sk, _lastChangedAt: now };
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
  } catch (e) {
    logError(e, `db/inspections.softDeleteInspection sk=${sk}`);
    throw e;
  }
}
