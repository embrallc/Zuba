import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import dayjs from "dayjs";
import { Platform } from "react-native";
import { db } from "./index";

// One id per app launch — groups every log/event from a single run so a session
// can be followed end-to-end in the cloud app_logs table.
export const SESSION_ID = Crypto.randomUUID();

// Captured once at module load; the log shipper attaches these to each cloud row.
// (No expo-device in this build → device_model stays null; the column exists for
// a later add.)
export const LOG_DEVICE_META = {
  platform: Platform.OS,
  os_version: Platform.Version != null ? String(Platform.Version) : null,
  app_version: Constants?.expoConfig?.version ?? null,
  device_model: null,
};

// Only these levels are durably buffered in AppLogs (and therefore shipped to
// the cloud). info/debug stay console-only — keeps the local buffer + cloud
// volume lean, per the prod level policy (error | warn | event).
const PERSIST_LEVELS = new Set(["error", "warn", "event"]);

export async function insertLog({
  level = "error",
  message,
  stackTrace,
  context,
  event,
  data,
}) {
  // Always surface to the Metro/device console for real-time dev visibility.
  const tag = context ? `[${context}]` : event ? `[${event}]` : "[app]";
  try {
    if (level === "error") {
      console.error(tag, message ?? "", stackTrace ? `\n${stackTrace}` : "");
    } else if (level === "warn") {
      console.warn(tag, message ?? "");
    } else {
      console.log(tag, message ?? event ?? "");
    }
  } catch {
    // console must never crash logging
  }

  // Drop info/debug from the durable buffer (console-only above).
  if (!PERSIST_LEVELS.has(level)) return;

  try {
    const sk = Crypto.randomUUID();
    const now = dayjs().valueOf();
    let dataStr = null;
    if (data != null) {
      try {
        dataStr = typeof data === "string" ? data : JSON.stringify(data);
      } catch {
        dataStr = null; // non-serializable payload — keep the row, drop the data
      }
    }
    await db.runAsync(
      `INSERT INTO AppLogs
         (LogSk, Level, Message, StackTrace, Context, Event, Data, SessionId, Synced, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        sk,
        level,
        message ?? null,
        stackTrace ?? null,
        context ?? null,
        event ?? null,
        dataStr,
        SESSION_ID,
        now,
      ],
    );
  } catch {
    // Logging must never crash the app
  }
}

// Error sink. `data` is an optional structured payload (ids/counts only — never
// customer PII). Signature is backward-compatible: logError(error, context).
export function logError(error, context, data) {
  return insertLog({
    level: "error",
    message: error?.message ?? String(error),
    stackTrace: error?.stack ?? null,
    context: context ?? null,
    data,
  });
}

// Non-fatal warning sink.
export function logWarn(message, context, data) {
  return insertLog({ level: "warn", message, context: context ?? null, data });
}

// Success/lifecycle telemetry — a dot-namespaced event name ('sync.completed',
// 'report.failed', …) with an optional structured payload (ids/counts/durations
// only — never customer PII). Failures end in '.failed' by convention so the
// process-health view can split success vs failure.
export function logEvent(name, data) {
  return insertLog({ level: "event", message: name, event: name, data });
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
