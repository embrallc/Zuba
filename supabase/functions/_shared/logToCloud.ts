// Shared server-side telemetry sink for Edge Functions.
//
// Writes a row into public.app_logs using the service-role client the caller
// already holds (EFs bypass RLS). Mirrors the device path (utils/logShipper.js)
// and the report-worker's logToCloud so all telemetry lands in one queryable
// table. Best-effort: logging must NEVER throw or break the request it observes.
//
// Levels shipped: 'error' | 'warn' | 'event'. Events are dot-namespaced
// 'domain.outcome' (e.g. autosend.sent / autosend.failed); failures end '.failed'.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CloudLogEntry {
  level?: "error" | "warn" | "event" | "info";
  event?: string;
  message?: string;
  context?: string;
  stack?: string;
  data?: Record<string, unknown> | null;
  userId?: string | null;
  orgSk?: string | null;
  jobId?: string | null;
  // Always identify the writer, e.g. "ef:reconcile-inspection".
  source: string;
}

export async function logToCloud(
  admin: SupabaseClient,
  entry: CloudLogEntry,
): Promise<void> {
  try {
    await admin.from("app_logs").insert({
      level: entry.level ?? (entry.event ? "event" : "error"),
      event: entry.event ?? null,
      message: entry.message ?? entry.event ?? null,
      context: entry.context ?? null,
      stack: entry.stack ?? null,
      data: entry.data ?? null,
      user_id: entry.userId ?? null,
      org_sk: entry.orgSk ?? null,
      job_id: entry.jobId ?? null,
      source: entry.source,
    });
  } catch (e) {
    // Never let telemetry break the caller.
    console.error(
      `[logToCloud] insert failed (${entry.source}):`,
      (e as Error)?.message,
    );
  }
}

// Convenience for a success/lifecycle event.
export function logCloudEvent(
  admin: SupabaseClient,
  source: string,
  event: string,
  fields: {
    data?: Record<string, unknown>;
    userId?: string | null;
    orgSk?: string | null;
    message?: string;
  } = {},
): Promise<void> {
  return logToCloud(admin, {
    level: "event",
    event,
    source,
    data: fields.data ?? null,
    userId: fields.userId ?? null,
    orgSk: fields.orgSk ?? null,
    message: fields.message,
  });
}
