import dayjs from "dayjs";
import * as Crypto from "expo-crypto";
import { db } from "./index";

export async function insertLog({
  level = "error",
  message,
  stackTrace,
  context,
}) {
  // Always surface to the Metro/device console too — until cloud log sync
  // lands (pre-launch), this is the only way failures are visible in real
  // time instead of being buried in the AppLogs table.
  const tag = context ? `[${context}]` : "[app]";
  try {
    if (level === "error") {
      console.error(tag, message ?? "", stackTrace ? `\n${stackTrace}` : "");
    } else if (level === "warn") {
      console.warn(tag, message ?? "");
    } else {
      console.log(tag, message ?? "");
    }
  } catch {
    // console must never crash logging
  }
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
