// Client side of the Cloud Run report worker.
//
// Flow (no Edge Function): the app INSERTs a report_jobs row (RLS: own rows),
// subscribes to it via Supabase Realtime, then POSTs to the Cloud Run worker
// with the user's Supabase JWT. The worker validates the JWT, generates the PDF
// detached, and flips the row to completed/failed — which streams back here via
// the subscription.

import dayjs from "dayjs";
import { logError, logWarn } from "../db/logs";
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
    // orgId is read from the job row server-side (not trusted from here).
    // tzOffsetMinutes formats dates in the PDF for the inspector's timezone.
    body: JSON.stringify({
      jobId,
      inspectionId: inspectionSk,
      tzOffsetMinutes: dayjs().utcOffset(),
    }),
  });
  if (res.status !== 202 && !res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Worker error ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json().catch(() => ({}));
}

// Status ordering — updates may only move FORWARD. Guards against a stale
// initial fetch (or out-of-order delivery) regressing a newer status back to
// "Queued". failed/completed are both terminal.
const STATUS_RANK = { pending: 0, processing: 1, completed: 2, failed: 2 };
const TERMINAL = new Set(["completed", "failed"]);
const POLL_MS = 4000;
// Give up after this long so a worker that died mid-render (row stuck on
// 'processing') doesn't poll forever. Generous — a heavy photo report can take
// a couple of minutes.
const MAX_POLL_MS = 5 * 60 * 1000;

// Track a single report_jobs row to a terminal state. Fires onRow(row) on each
// FORWARD change. Uses Realtime for snappiness AND a polling backstop, because
// Realtime alone is unreliable for long jobs: a 30–60s render gives the socket
// ample chance to drop (screen sleep, backgrounding, a network blip) and miss
// the `completed` event, leaving the UI stuck on "Queued". The report_jobs row
// is the source of truth, so we poll it until it settles. Returns unsubscribe.
export function subscribeToJob(jobId, onRow) {
  let active = true;
  let lastRank = -1;
  let pollTimer = null;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  // Apply a row only if it advances the status; stop everything once terminal.
  const emit = (row) => {
    if (!active || !row?.status) return;
    const rank = STATUS_RANK[row.status] ?? 0;
    if (rank < lastRank) return; // never regress
    lastRank = rank;
    onRow(row);
    if (TERMINAL.has(row.status)) {
      stopPolling();
      active = false;
      try {
        supabase.removeChannel(channel);
      } catch (_) {}
    }
  };

  const fetchOnce = () => {
    supabase
      .from("report_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) emit(data);
      })
      .catch(() => {});
  };

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
        if (payload?.new) emit(payload.new);
      },
    )
    .subscribe((status, err) => {
      // Transient socket drops (CHANNEL_ERROR/TIMED_OUT) are expected and
      // self-healing; the poll backstop covers the gap. Log at WARN (not error)
      // so a blip isn't alarming, while a chronically broken channel stays visible.
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        logWarn(
          `report_jobs realtime ${status}: ${err?.message ?? "disconnected"}`,
          `reportJobs.subscribeToJob job=${jobId}`,
        );
      }
    });

  // Initial read (catches a job that finished before realtime attached) + the
  // polling backstop until the row settles or the deadline passes.
  const startedAt = Date.now();
  fetchOnce();
  pollTimer = setInterval(() => {
    if (Date.now() - startedAt > MAX_POLL_MS) {
      const wasActive = active;
      stopPolling();
      active = false;
      try {
        supabase.removeChannel(channel);
      } catch (_) {}
      if (wasActive) {
        onRow({
          id: jobId,
          status: "failed",
          error:
            "Timed out waiting for the report. It may still be finishing — reopen in a moment.",
        });
      }
      return;
    }
    fetchOnce();
  }, POLL_MS);

  return () => {
    active = false;
    stopPolling();
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
    // The worker didn't ack (it sets 'processing' before responding 202), so
    // the row is still 'pending' and won't move. Tear down the poll FIRST so it
    // can't fetch that stale 'pending' and regress the UI back to "Queued",
    // then surface the dispatch failure.
    logError(e, `reportJobs.startCloudReport sk=${inspection.InspectionSk}`);
    unsubscribe();
    onUpdate({ id: jobId, status: "failed", error: e?.message ?? "Request failed" });
  }
  return { jobId, unsubscribe };
}
