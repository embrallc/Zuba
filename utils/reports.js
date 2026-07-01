// Report generation client orchestrator.
//
// Flow: syncAll (so the cloud has the freshest form data + photos — the worker
// reads Postgres/Storage, never the device) → run the Railway worker job
// (report_jobs row + Realtime) → download the finished PDF once into the app
// sandbox → record the local path on the inspection row. Reviewing/sharing
// afterwards never re-downloads.
//
// Restore (cache miss) still uses the generate-report Edge Function's
// `action:"latest"` retrieval mode — that EF stays for now.

import * as FileSystem from "expo-file-system/legacy";
import { setInspectionLocalReport } from "../db/inspections";
import { logError, logEvent } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { isWorkerConfigured, startCloudReport } from "./reportJobs";
import { supabase } from "./supabase";
import { syncAll } from "./sync";

// cacheDirectory on purpose (Apple data-storage guidelines): the PDFs are
// re-downloadable from the inspection-reports bucket, so they belong in the
// purgeable, non-backed-up cache. If the OS (or a future clear-storage
// feature) evicts them, getOrRestoreReport re-pulls from the cloud.
const REPORTS_DIR = `${FileSystem.cacheDirectory}reports/`;

function sanitizeName(name) {
  return (name || "Inspection")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

// Share-sheet-friendly file name — this is what the client sees attached to
// the email/text.
export function reportFileName(inspection) {
  return `Inspection-Report-${sanitizeName(inspection?.FullName)}.pdf`;
}

async function ensureReportsDir(inspectionSk) {
  const dir = `${REPORTS_DIR}${inspectionSk}/`;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch (e) {
    logError(e, "utils/reports.ensureReportsDir");
  }
  return dir;
}

// Returns the cached local PDF path if the file actually exists, else null.
// (The DB column can outlive the file — the OS may purge the cache dir.)
export async function getLocalReport(inspection) {
  const path = inspection?.LastReportPath;
  if (!path) return null;
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : null;
  } catch (_) {
    return null;
  }
}

// Shared by generate + restore: pull the PDF at signedUrl into the cache and
// record it on the inspection row.
async function downloadAndRecord(inspection, signedUrl, generatedAtMs) {
  const sk = inspection.InspectionSk;
  const dir = await ensureReportsDir(sk);
  const dest = `${dir}${reportFileName(inspection)}`;
  const dl = await FileSystem.downloadAsync(signedUrl, dest);
  if (dl?.status !== 200) {
    throw new Error("Couldn't download the report.");
  }
  const updated = await setInspectionLocalReport(sk, dest, generatedAtMs);
  if (updated) {
    // Only reflect into the active store if the inspection is already there —
    // never inject a completed/archived inspection back into the active lists
    // (generating/viewing a report from the Archive must not "un-complete" it).
    const store = useInspectionStore.getState();
    if (store.inspections[sk]) store.update(updated);
  }
  return dest;
}

// Cache miss → re-pull the newest stored PDF from the cloud and re-cache it.
// Returns the local path, or null when no report was ever generated (or the
// restore failed — both render the same "generate one" guidance).
async function restoreReportFromCloud(inspection) {
  const sk = inspection?.InspectionSk;
  if (!sk) return null;
  try {
    const { data, error } = await supabase.functions.invoke("generate-report", {
      body: { inspectionSk: sk, action: "latest" },
    });
    if (error || !data?.signedUrl) {
      if (error) logError(error, `utils/reports.restore sk=${sk}`);
      return null;
    }
    const at = Date.parse(data.generatedAt ?? "") || Date.now();
    return await downloadAndRecord(inspection, data.signedUrl, at);
  } catch (e) {
    logError(e, `utils/reports.restore sk=${sk}`);
    return null;
  }
}

// Local cache first; on miss, transparently restore from the cloud copy.
// The viewer uses this so a purged cache never dead-ends the user.
export async function getOrRestoreReport(inspection) {
  const local = await getLocalReport(inspection);
  if (local) return local;
  return restoreReportFromCloud(inspection);
}

// Drive a worker report job to a terminal state, wrapping the create →
// subscribe → kick flow (startCloudReport) in a Promise that resolves with the
// completed row (carrying report_url) or rejects with a presentable error.
// `onProgress(status)` receives each forward status: pending|processing|...
function runWorkerJob(inspection, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    startCloudReport(inspection, (row) => {
      if (settled || !row?.status) return;
      onProgress?.(row.status);
      if (row.status === "completed") {
        settled = true;
        if (row.report_url) {
          resolve(row);
        } else {
          const e = new Error("The report finished but no file came back.");
          e.presentable = true;
          reject(e);
        }
      } else if (row.status === "failed") {
        settled = true;
        const e = new Error(row.error || "The report failed to generate.");
        e.presentable = true;
        reject(e);
      }
    }).catch((e) => {
      // startCloudReport reports a dispatch failure through the callback above
      // (status:'failed'); this catch covers a throw before that (e.g. job
      // insert failed). subscribeToJob cleans up its own channel on terminal.
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

// Generate (or regenerate) the report for one inspection via the Railway worker.
// Returns { path, pageCount, usedDraft, skippedPhotos } or throws with a
// user-presentable `message`. `onProgress` is optional (status strings).
export async function generateInspectionReport(inspection, onProgress) {
  const sk = inspection?.InspectionSk;
  if (!sk) throw new Error("missing inspection");
  if (!isWorkerConfigured()) {
    const err = new Error(
      "The report service isn't configured on this build. Please contact support.",
    );
    err.presentable = true;
    throw err;
  }

  const startedAt = Date.now();
  try {
    // Push local edits/photos first — the worker renders from the cloud copy.
    try {
      await syncAll();
    } catch (e) {
      logError(e, "utils/reports.generate.sync");
      // Continue — worst case the report reflects the last synced state.
    }

    // Worker job → completed row (report_url is a signed URL to the PDF).
    const row = await runWorkerJob(inspection, onProgress);
    const path = await downloadAndRecord(inspection, row.report_url, Date.now());

    logEvent("report.generated", {
      sk,
      source: "manual",
      durationMs: Date.now() - startedAt,
    });
    // The report_jobs row doesn't carry pageCount/usedDraft/skippedPhotos (those
    // live on the worker side only), so the banner just reports success.
    return { path, pageCount: null, usedDraft: false, skippedPhotos: 0 };
  } catch (e) {
    logEvent("report.failed", {
      sk,
      source: "manual",
      durationMs: Date.now() - startedAt,
      reason: e?.message ?? String(e),
    });
    throw e;
  }
}

// Remove ONE inspection's cached PDF + clear its device-local pointer. Called
// when an inspection is completed: a completed report lives in the cloud and is
// re-fetched on demand, so keeping it cached just grows the app's footprint.
// Best-effort — never throws.
export async function deleteLocalReport(inspection) {
  const sk = inspection?.InspectionSk;
  if (!sk) return;
  try {
    const dir = `${REPORTS_DIR}${sk}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (info.exists) await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch (e) {
    logError(e, `utils/reports.deleteLocalReport sk=${sk}`);
  }
  try {
    const updated = await setInspectionLocalReport(sk, null, null);
    if (updated) {
      const store = useInspectionStore.getState();
      if (store.inspections[sk]) store.update(updated);
    }
  } catch (e) {
    logError(e, `utils/reports.deleteLocalReport.clear sk=${sk}`);
  }
}

// Wipe the entire reports cache (Settings → Clear cached reports). Stale
// LastReportPath columns are harmless — getLocalReport returns null for a
// missing file and the viewer restores from the cloud. Best-effort.
export async function clearAllReportCache() {
  try {
    const info = await FileSystem.getInfoAsync(REPORTS_DIR);
    if (info.exists) await FileSystem.deleteAsync(REPORTS_DIR, { idempotent: true });
  } catch (e) {
    logError(e, "utils/reports.clearAllReportCache");
    throw e;
  }
}
