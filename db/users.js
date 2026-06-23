import AsyncStorage from "@react-native-async-storage/async-storage";
import dayjs from "dayjs";
import { supabase } from "../utils/supabase";
import { db } from "./index";
import { logError } from "./logs";

const USER_SK_KEY = "user_sk";

// Read the current user's row from local SQLite. Returns null if missing.
export async function getLocalUser(userSk) {
  try {
    return await db.getFirstAsync(
      `SELECT UserSk, UserId, fname, lname, OrgSk, UserProfile FROM Users WHERE UserId = ?`,
      [userSk],
    );
  } catch (e) {
    logError(e, `db/users.getLocalUser sk=${userSk}`);
    return null;
  }
}

// Pull the current user's row from the cloud and reconcile into local SQLite.
// Best-effort — returns null on any failure so loadUserData can continue.
export async function pullSelfUser(userSk) {
  try {
    if (!userSk) return null;
    const { data, error } = await supabase
      .from("users")
      .select("fname, lname, user_profile, org_sk")
      .eq("id", userSk)
      .maybeSingle();
    if (error) {
      logError(error, `db/users.pullSelfUser sk=${userSk}`);
      return null;
    }
    if (!data) return null;
    await db.runAsync(
      `UPDATE Users SET fname = ?, lname = ?, UserProfile = ?, OrgSk = ? WHERE UserId = ?`,
      [
        data.fname ?? null,
        data.lname ?? null,
        data.user_profile ?? null,
        data.org_sk ?? null,
        userSk,
      ],
    );
    return data;
  } catch (e) {
    logError(e, `db/users.pullSelfUser sk=${userSk}`);
    return null;
  }
}

// Update the current user's name in local SQLite + the cloud users row.
// Returns true on success, false if either side failed (caller can revert).
export async function updateUserName(userSk, { fname, lname }) {
  try {
    if (!userSk) return false;
    await db.runAsync(
      `UPDATE Users SET fname = ?, lname = ?, _lastChangedAt = ? WHERE UserId = ?`,
      [fname ?? null, lname ?? null, dayjs().valueOf(), userSk],
    );
    const { error } = await supabase
      .from("users")
      .update({ fname: fname ?? null, lname: lname ?? null })
      .eq("id", userSk);
    if (error) {
      logError(error, `db/users.updateUserName sk=${userSk}`);
      return false;
    }
    return true;
  } catch (e) {
    logError(e, `db/users.updateUserName sk=${userSk}`);
    return false;
  }
}

export async function getOrCreateUser(supabaseUid, orgSk, userProfile) {
  try {
    const now = dayjs().valueOf();
    // OrgSk is NOT NULL locally. If org_sk is ever missing from the session,
    // `INSERT OR IGNORE` would SILENTLY skip the row (OR IGNORE swallows the
    // NOT NULL violation) — and then EVERY inspection's `UserSk -> Users` FK
    // fails on the next pull, leaving the schedule empty with no error. Coalesce
    // to '' so the parent row always exists; pullSelfUser backfills the real
    // org_sk from the cloud moments later.
    const safeOrgSk = orgSk ?? "";
    await db.runAsync(
      `INSERT OR IGNORE INTO Users (UserSk, UserId, OrgSk, UserProfile, Role, _version, _lastChangedAt, _deleted)
       VALUES (?, ?, ?, ?, 'user', 1, ?, 0)`,
      [supabaseUid, supabaseUid, safeOrgSk, userProfile, now],
    );
    // Keep the local cache in sync with auth metadata on every login —
    // role/org may have changed cloud-side since the row was first inserted.
    // COALESCE so a null incoming org_sk never wipes a good stored one.
    await db.runAsync(
      `UPDATE Users SET UserProfile = ?, OrgSk = COALESCE(?, OrgSk) WHERE UserId = ?`,
      [userProfile, orgSk ?? null, supabaseUid],
    );
    // Verify the parent row actually exists — if it somehow doesn't, surface it
    // loudly rather than letting inspections silently fail to sync.
    const row = await db.getFirstAsync(
      `SELECT UserSk FROM Users WHERE UserId = ?`,
      [supabaseUid],
    );
    if (!row) {
      logError(
        new Error(
          `Users row missing after upsert (orgSk=${orgSk ?? "null"}) — inspections will fail their FK`,
        ),
        "db/users.getOrCreateUser:verify",
      );
    }
    await AsyncStorage.setItem(USER_SK_KEY, supabaseUid);
    return supabaseUid;
  } catch (e) {
    logError(e, "db/users.getOrCreateUser");
    throw e;
  }
}
