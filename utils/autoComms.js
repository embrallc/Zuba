import { logError } from "../db/logs";
import { supabase } from "./supabase";

// Nudge the server to converge an inspection's auto-comms state (policy
// snapshot + auto-send/hold the report). The reconciler is idempotent and the
// pg_cron sweep backstops it, so this is fire-and-forget: failures are logged,
// never surfaced, and never block the UI.
export async function reconcileInspection(inspectionSk) {
  if (!inspectionSk) return;
  try {
    await supabase.functions.invoke("reconcile-inspection", {
      body: { inspectionSk },
    });
  } catch (e) {
    logError(e, `utils/autoComms.reconcileInspection sk=${inspectionSk}`);
  }
}
