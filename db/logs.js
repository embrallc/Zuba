import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
import { db } from "./index";

export async function insertLog({
  level = "error",
  message,
  stackTrace,
  context,
}) {
  try {
    const sk = Crypto.randomUUID();
    const now = dayjs().valueOf();
    await db.runAsync(
      `INSERT INTO AppLogs (LogSk, Level, Message, StackTrace, Context, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sk, level, message ?? null, stackTrace ?? null, context ?? null, now],
    );
  } catch {
    // Logging must never crash the app
  }
}

export async function getAllLogs() {
  try {
    const logs = await db.getAllAsync(`SELECT * FROM AppLogs`);
    console.log(logs.length);
    logs.forEach((log) => console.log(log));
  } catch {
    console.log("Error getting logs");
  }
}

export function logError(error, context) {
  return insertLog({
    level: "error",
    message: error?.message ?? String(error),
    stackTrace: error?.stack ?? null,
    context: context ?? null,
  });
}
