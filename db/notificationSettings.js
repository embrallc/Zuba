import dayjs from "dayjs";
import { randomUUID } from "expo-crypto";
import { db } from "./index";
import { logError } from "./logs";

// Canonical names. UI + scheduler reference these so a typo can't desync
// the row's NotificationName from the code looking it up.
export const NOTIFICATION_NAMES = {
  UPCOMING_APPT: "upcomingAppt",
};

// All notification rows for the given user. Empty array if none — caller
// should treat absent rows as "off" defaults.
export async function listNotificationSettings(userId) {
  try {
    return await db.getAllAsync(
      "SELECT * FROM NotificationSettings WHERE UserId = ?",
      [userId],
    );
  } catch (e) {
    logError(e, `db/notificationSettings.list userId=${userId}`);
    return [];
  }
}

// Upsert by (UserId, NotificationName). New rows get a fresh NotificationSk;
// existing rows keep theirs and bump _version so the sync push overwrites the
// older cloud copy.
export async function upsertNotificationSetting(
  userId,
  notificationName,
  isOn,
) {
  try {
    const now = dayjs().valueOf();
    const existing = db.getFirstSync(
      "SELECT NotificationSk, _version FROM NotificationSettings WHERE UserId = ? AND NotificationName = ?",
      [userId, notificationName],
    );
    if (existing) {
      await db.runAsync(
        `UPDATE NotificationSettings
           SET IsNotificationOn = ?, _version = ?, _lastChangedAt = ?, Synced = 0
         WHERE NotificationSk = ?`,
        [
          isOn ? 1 : 0,
          (existing._version ?? 1) + 1,
          now,
          existing.NotificationSk,
        ],
      );
      return existing.NotificationSk;
    }
    const sk = randomUUID();
    await db.runAsync(
      `INSERT INTO NotificationSettings
         (NotificationSk, UserId, NotificationName, IsNotificationOn,
          _version, _lastChangedAt, Synced)
       VALUES (?, ?, ?, ?, 1, ?, 0)`,
      [sk, userId, notificationName, isOn ? 1 : 0, now],
    );
    return sk;
  } catch (e) {
    logError(
      e,
      `db/notificationSettings.upsert userId=${userId} name=${notificationName}`,
    );
    throw e;
  }
}
