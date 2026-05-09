import AsyncStorage from "@react-native-async-storage/async-storage";
import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
import { db } from "./index";
import { logError } from "./logs";

const USER_SK_KEY = "user_sk";

export async function getOrCreateUser() {
  try {
    let userSk = await AsyncStorage.getItem(USER_SK_KEY);

    if (!userSk) {
      userSk = Crypto.randomUUID();
      const now = dayjs().valueOf();
      await db.runAsync(
        `INSERT INTO Users (UserSk, UserId, OrgSk, Role, _version, _lastChangedAt, _deleted)
         VALUES (?, ?, ?, 'user', 1, ?, 0)`,
        [userSk, userSk, userSk, now],
      );
      await AsyncStorage.setItem(USER_SK_KEY, userSk);
    }

    return userSk;
  } catch (e) {
    logError(e, "db/users.getOrCreateUser");
    throw e;
  }
}
