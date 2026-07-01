import { DB_EVENTS, emit } from "../db/events";
import { db } from "../db/index";
import { logError, logWarn } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { supabase } from "./supabase";

// Live cancellation channel. When a client texts "X" to their day-before
// reminder, the inbound Edge Function sets the inspection's status to CANCELLED
// server-side. This subscribes the assigned inspector's app to its OWN
// inspection changes so that cancellation lands instantly while the app is open
// (the normal pull-sync is the fallback when backgrounded).
//
// Deliberately NARROW: we only act on a transition INTO 'CANCELLED'. Every other
// field stays owned by the manifest-diff pull-sync — reacting to all changes
// here would double-apply normal edits and fight the conflict resolver.

let channel = null;

export async function startInspectionRealtime() {
  try {
    if (channel) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const userId = user?.id;
    if (!userId) return;

    channel = supabase
      .channel(`inspections:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "inspections",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          handleCloudRow(payload?.new).catch((e) =>
            logError(e, "inspectionRealtime.handleCloudRow"),
          );
        },
      )
      .subscribe((status, err) => {
        // A dropped socket (e.g. 1001 "Stream end" on backgrounding / a network
        // blip / WS idle-timeout) surfaces here as CHANNEL_ERROR/TIMED_OUT.
        // realtime-js auto-reconnects and the manifest-diff pull-sync is the
        // backstop, so this is NON-FATAL and expected. Log at WARN (not error) so
        // a transient blip isn't alarming, while a chronically broken channel is
        // still visible.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          logWarn(
            `inspections realtime ${status}: ${err?.message ?? "disconnected"}`,
            "inspectionRealtime.subscribe",
          );
        }
      });
  } catch (e) {
    logError(e, "inspectionRealtime.start");
  }
}

export function stopInspectionRealtime() {
  if (!channel) return;
  try {
    supabase.removeChannel(channel);
  } catch (_) {}
  channel = null;
}

async function handleCloudRow(row) {
  if (!row || row.status !== "CANCELLED") return;
  const sk = row.inspection_sk;
  if (!sk) return;

  // Only act if we have the row and it isn't already cancelled locally — keeps
  // this idempotent against echoes of a pull that already applied the change.
  const local = await db.getFirstAsync(
    `SELECT Status FROM Inspections WHERE InspectionSk = ?`,
    [sk],
  );
  if (!local) return;
  if ((local.Status ?? "OPEN") === "CANCELLED") return;

  // Apply locally. Synced=1 because this came FROM the cloud (no push back);
  // stamp _lastChangedAt from the cloud value so the unread-cancellation badge's
  // "newer than viewedAt" math is correct.
  const changedAt = Number(row._last_changed_at) || Date.now();
  await db.runAsync(
    `UPDATE Inspections SET Status = 'CANCELLED', _version = ?, _lastChangedAt = ?, Synced = 1
     WHERE InspectionSk = ?`,
    [Number(row._version) || 1, changedAt, sk],
  );
  const updated = await db.getFirstAsync(
    `SELECT * FROM Inspections WHERE InspectionSk = ?`,
    [sk],
  );

  // Drop it from the active list live, fire INSPECTION_UPDATED (cancels any
  // pending local reminder via the notification subscriber), and refresh + bounce
  // the unread-cancellation badge (count alone updates silently — the pulse is
  // what replays the attention bounce on whatever screen is showing the badge).
  useInspectionStore.getState().remove(sk);
  if (updated) emit(DB_EVENTS.INSPECTION_UPDATED, updated);
  const settings = useSettingsStore.getState();
  settings.refreshCancelledCount?.();
  settings.bumpCancelBadgePulse?.();
}
