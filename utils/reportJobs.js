// Client side of the Cloud Run report worker.
//
// Flow (no Edge Function): the app INSERTs a report_jobs row (RLS: own rows),
// subscribes to it via Supabase Realtime, then POSTs to the Cloud Run worker
// with the user's Supabase JWT. The worker validates the JWT, generates the PDF
// detached, and flips the row to completed/failed — which streams back here via
// the subscription.

import { logError } from "../db/logs";
import { useSettingsStore } from "../stores/useSettingsStore";
import { supabase } from "./supabase";

// Public endpoint — the JWT is the credential, not this URL. Set in app config
// (EXPO_PUBLIC_ vars are inlined into the bundle at build time).
const WORKER_URL = (process.env.EXPO_PUBLIC_REPORT_WORKER_URL || "").replace(
  /\/$/,
  "",
);

export function isWorkerConfigured() {
  return !!WORKER_URL;
}

async function currentSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ?? null;
}

// Insert the job row (status 'pending'). Returns { jobId, orgSk }.
export async function createReportJob(inspection) {
  const session = await currentSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("You're signed out.");
  const orgSk = useSettingsStore.getState()?.orgSk ?? null;
  const { data, error } = await supabase
    .from("report_jobs")
    .insert({
      inspection_sk: inspection.InspectionSk,
      org_sk: orgSk,
      user_id: userId,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { jobId: data.id, orgSk };
}

// Fire the worker. Expects a 202; throws with detail otherwise.
export async function requestWorker({ jobId, inspectionSk, orgSk }) {
  if (!WORKER_URL) throw new Error("Report worker URL isn't configured.");
  const session = await currentSession();
  const jwt = session?.access_token;
  if (!jwt) throw new Error("You're signed out.");
  const res = await fetch(`${WORKER_URL}/api/generate-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ jobId, inspectionId: inspectionSk, orgId: orgSk }),
  });
  if (res.status !== 202 && !res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Worker error ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json().catch(() => ({}));
}

// Subscribe to a single report_jobs row. Fires onRow(row) on each change, plus
// one initial fetch so a job that finished before realtime attached isn't
// missed. Returns an unsubscribe fn.
export function subscribeToJob(jobId, onRow) {
  let active = true;
  supabase
    .from("report_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle()
    .then(({ data }) => {
      if (active && data) onRow(data);
    })
    .catch(() => {});
  const channel = supabase
    .channel(`report_job:${jobId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "report_jobs",
        filter: `id=eq.${jobId}`,
      },
      (payload) => {
        console.log(`[reportJobs] realtime payload job=${jobId}`, payload?.new?.status);
        if (active && payload?.new) onRow(payload.new);
      },
    )
    .subscribe((status, err) => {
      // SUBSCRIBED = good. CHANNEL_ERROR/TIMED_OUT = the app won't receive row
      // updates (RLS/auth/publication issue) and will appear stuck on "Queued".
      console.log(`[reportJobs] channel status job=${jobId}: ${status}`, err ?? "");
    });
  return () => {
    active = false;
    try {
      supabase.removeChannel(channel);
    } catch (_) {}
  };
}

// Orchestrator: create → subscribe → kick the worker. Status flows back through
// onUpdate({ status, report_url, error }). Returns { jobId, unsubscribe }.
export async function startCloudReport(inspection, onUpdate) {
  const { jobId, orgSk } = await createReportJob(inspection);
  const unsubscribe = subscribeToJob(jobId, onUpdate);
  try {
    await requestWorker({
      jobId,
      inspectionSk: inspection.InspectionSk,
      orgSk,
    });
  } catch (e) {
    logError(e, `reportJobs.startCloudReport sk=${inspection.InspectionSk}`);
    onUpdate({ id: jobId, status: "failed", error: e?.message ?? "Request failed" });
  }
  return { jobId, unsubscribe };
}
