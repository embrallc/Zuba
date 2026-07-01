// Cloud log shipper — drains the local AppLogs buffer into the cloud app_logs
// table in batches. AppLogs is the durable offline queue (rows written with
// Synced = 0 by db/logs.js); this flips them to Synced = 1 once accepted by the
// cloud. Mirrors the app's dirty-flag sync pattern, but is deliberately SEPARATE
// from syncAll(): logs are append-only and one-directional, must not bloat or
// block the business-data sync, and must keep flowing even when that sync fails.
//
// Hard rule: nothing in here may call logError/logEvent/insertLog. A logging
// failure that logged itself would write a new AppLogs row → ship → fail → loop.
// All failures here go to console.warn only.
//
// Auth/RLS: the cloud app_logs insert policy requires auth.uid() = user_id, so we
// attach the current session's user_id and skip entirely when there's no session
// (pre-login buffered rows wait until someone signs in, then ship under that id).

import { AppState } from "react-native";
import { db } from "../db/index";
import { LOG_DEVICE_META, SESSION_ID } from "../db/logs";
import { addReconnectListener, isOnline } from "./connectivity";
import { supabase } from "./supabase";

const BATCH = 200; // rows per upsert (PostgREST-friendly)
const MAX_BATCHES_PER_FLUSH = 25; // ≤5000 rows/flush — bounds a backlog drain
const FLUSH_INTERVAL_MS = 30000; // 30s foreground cadence
const LOCAL_RETAIN_DAYS = 7; // keep shipped rows locally this long
const LOCAL_ROW_CAP = 5000; // hard cap on the local buffer (synced rows only)

let flushing = false;
let intervalId = null;
let appStateSub = null;
let removeReconnect = null;

// The caller's org_sk from the local Users mirror (denormalized onto each log
// row so the owner can filter org-wide). Best-effort.
function currentOrgSk(userId) {
  try {
    const row = db.getFirstSync(`SELECT OrgSk FROM Users WHERE UserId = ?`, [userId]);
    return row?.OrgSk ?? null;
  } catch {
    return null;
  }
}

function parseData(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Drain Synced = 0 rows to the cloud. Re-entrancy-guarded; safe to call from the
// interval, AppState, reconnect, and boot simultaneously.
export async function flushLogs() {
  if (flushing) return;
  if (!isOnline()) return;
  flushing = true;
  try {
    let session = null;
    try {
      const res = await supabase.auth.getSession();
      session = res?.data?.session ?? null;
    } catch {
      session = null;
    }
    const userId = session?.user?.id;
    if (!userId) return; // no session → can't satisfy the insert RLS; try later

    const orgSk = currentOrgSk(userId);

    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      let rows;
      try {
        rows = await db.getAllAsync(
          `SELECT LogSk, Level, Message, StackTrace, Context, Event, Data, SessionId, CreatedAt
             FROM AppLogs WHERE Synced = 0 ORDER BY CreatedAt ASC LIMIT ${BATCH}`,
        );
      } catch (e) {
        console.warn("[logShipper] read failed:", e?.message);
        break;
      }
      if (!rows || rows.length === 0) break;

      const cloudRows = rows.map((r) => ({
        log_sk: r.LogSk,
        level: r.Level ?? "info",
        message: r.Message ?? null,
        context: r.Context ?? null,
        stack: r.StackTrace ?? null,
        event: r.Event ?? null,
        data: parseData(r.Data),
        user_id: userId,
        org_sk: orgSk,
        session_id: r.SessionId ?? SESSION_ID,
        client_ts: new Date(r.CreatedAt ?? Date.now()).toISOString(),
        source: "app",
        platform: LOG_DEVICE_META.platform,
        app_version: LOG_DEVICE_META.app_version,
        device_model: LOG_DEVICE_META.device_model,
        os_version: LOG_DEVICE_META.os_version,
      }));

      // ignoreDuplicates → ON CONFLICT (log_sk) DO NOTHING. This is what keeps it
      // append-only (no UPDATE privilege needed) AND idempotent: a re-ship of a
      // row whose mark-synced failed last time is skipped server-side.
      const { error } = await supabase
        .from("app_logs")
        .upsert(cloudRows, { onConflict: "log_sk", ignoreDuplicates: true });
      if (error) {
        // Offline / transient / RLS — leave rows dirty, retry next tick. NEVER
        // logError here (would recurse through the buffer).
        console.warn("[logShipper] upsert failed:", error.message);
        break;
      }

      const ids = rows.map((r) => r.LogSk);
      try {
        const placeholders = ids.map(() => "?").join(",");
        await db.runAsync(
          `UPDATE AppLogs SET Synced = 1 WHERE LogSk IN (${placeholders})`,
          ids,
        );
      } catch (e) {
        console.warn("[logShipper] mark-synced failed:", e?.message);
        break; // stop, or we'd re-ship the same rows next iteration
      }

      if (rows.length < BATCH) break; // drained
    }

    await pruneLocalLogs();
  } finally {
    flushing = false;
  }
}

// Bound the local buffer. Only ever deletes SHIPPED (Synced = 1) rows, so an
// unshipped error/event is never silently dropped — even on a long-offline device.
async function pruneLocalLogs() {
  const cutoff = Date.now() - LOCAL_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  try {
    await db.runAsync(`DELETE FROM AppLogs WHERE Synced = 1 AND CreatedAt < ?`, [cutoff]);
  } catch (e) {
    console.warn("[logShipper] prune(age) failed:", e?.message);
  }
  try {
    await db.runAsync(
      `DELETE FROM AppLogs
        WHERE Synced = 1
          AND LogSk NOT IN (
            SELECT LogSk FROM AppLogs ORDER BY CreatedAt DESC LIMIT ${LOCAL_ROW_CAP}
          )`,
    );
  } catch (e) {
    console.warn("[logShipper] prune(cap) failed:", e?.message);
  }
}

export function startLogShipper() {
  if (intervalId) return;
  intervalId = setInterval(() => {
    flushLogs();
  }, FLUSH_INTERVAL_MS);
  // Drain last run's buffered logs shortly after boot (off the critical path).
  setTimeout(() => {
    flushLogs();
  }, 5000);
  // Last chance to ship before the OS suspends the app.
  try {
    appStateSub = AppState.addEventListener("change", (s) => {
      if (s === "background" || s === "inactive") flushLogs();
    });
  } catch {
    appStateSub = null;
  }
  // Ship immediately the moment connectivity returns (one-way dep: connectivity
  // never imports this module).
  try {
    removeReconnect = addReconnectListener(() => {
      flushLogs();
    });
  } catch {
    removeReconnect = null;
  }
}

export function stopLogShipper() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (appStateSub) {
    try {
      appStateSub.remove();
    } catch {}
    appStateSub = null;
  }
  if (removeReconnect) {
    try {
      removeReconnect();
    } catch {}
    removeReconnect = null;
  }
}
