import AsyncStorage from "@react-native-async-storage/async-storage";
import dayjs from "dayjs";
import { db } from "./index";
import { logError } from "./logs";

const USER_SK_KEY = "user_sk";

export async function getOrCreateUser(supabaseUid, orgSk, userProfile) {
  try {
    const cached = await AsyncStorage.getItem(USER_SK_KEY);
    if (cached === supabaseUid) return supabaseUid;

    const now = dayjs().valueOf();
    await db.runAsync(
      `INSERT OR IGNORE INTO Users (UserSk, UserId, OrgSk, UserProfile, Role, _version, _lastChangedAt, _deleted)
       VALUES (?, ?, ?, ?, 'user', 1, ?, 0)`,
      [supabaseUid, supabaseUid, orgSk, userProfile, now],
    );
    await AsyncStorage.setItem(USER_SK_KEY, supabaseUid);
    return supabaseUid;
  } catch (e) {
    logError(e, "db/users.getOrCreateUser");
    throw e;
  }
}
