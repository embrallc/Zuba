import { logError } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Nudge the server to converge an inspection's auto-comms state (policy
// snapshot + auto-send/hold the report). The reconciler is idempotent and the
// pg_cron sweep backstops it, so this is fire-and-forget: failures are logged,
// never surfaced, and never block the UI.
export async function reconcileInspection(inspectionSk) {
  if (!inspectionSk) return;
  // Fire-and-forget nudge — skip offline so it can't hang a Complete action.
  // The idempotent pg_cron sweep (and the next online reconcile) backstop it.
  if (!isOnline()) return;
  try {
    await supabase.functions.invoke("reconcile-inspection", {
      body: { inspectionSk },
    });
  } catch (e) {
    logError(e, `utils/autoComms.reconcileInspection sk=${inspectionSk}`);
  }
}
