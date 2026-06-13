// Report generation client orchestrator.
//
// Flow: syncAll (so the cloud has the freshest form data + photos — the edge
// function reads Postgres/Storage, never the device) → invoke generate-report
// → download the PDF once into the app sandbox → record the local path on the
// inspection row. Reviewing/sharing afterwards never re-downloads.

import dayjs from "dayjs";
import * as FileSystem from "expo-file-system/legacy";
import { setInspectionLocalReport } from "../db/inspections";
import { logError } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
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
  if (updated) useInspectionStore.getState().update(updated);
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

// Generate (or regenerate) the report for one inspection. Returns
// { path, pageCount, usedDraft, skippedPhotos } or throws with a
// user-presentable `message`.
export async function generateInspectionReport(inspection) {
  const sk = inspection?.InspectionSk;
  if (!sk) throw new Error("missing inspection");

  // Push local edits/photos first — the server renders from the cloud copy.
  try {
    await syncAll();
  } catch (e) {
    logError(e, "utils/reports.generate.sync");
    // Continue — worst case the report reflects the last synced state.
  }

  const { data, error } = await supabase.functions.invoke("generate-report", {
    body: { inspectionSk: sk, tzOffsetMinutes: dayjs().utcOffset() },
  });

  if (error) {
    // Read the real server-side reason out of the FunctionsHttpError wrapper
    // (same pattern as delete-account in settings).
    let message = "Couldn't generate the report. Check your connection.";
    try {
      const body = await error.context?.json?.();
      if (body?.error === "no_template") {
        message =
          body?.message ??
          "No report template yet. Design one in Settings → Form Builder.";
      } else if (body?.error) {
        message = `Report generation failed (${body.error}).`;
      }
    } catch (_) {}
    logError(error, `utils/reports.generate.invoke sk=${sk}`);
    const err = new Error(message);
    err.presentable = true;
    throw err;
  }
  if (!data?.signedUrl) {
    throw new Error("Report service returned no file.");
  }

  const path = await downloadAndRecord(inspection, data.signedUrl, Date.now());

  return {
    path,
    pageCount: data.pageCount ?? null,
    usedDraft: !!data.usedDraft,
    skippedPhotos: data.skippedPhotos ?? 0,
  };
}
