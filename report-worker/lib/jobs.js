import { admin } from "./supabase.js";

const REPORT_BUCKET = process.env.REPORT_BUCKET || "inspection-reports";
// Default 7 days. Matches the spirit of the EF's signed links (which use 24h–30d
// depending on path); tune via env.
const SIGNED_URL_TTL = Number(process.env.SIGNED_URL_TTL || 60 * 60 * 24 * 7);

// Load the job row (service role). Used to authorize the caller + read its
// inspection/org for generation.
export async function loadJob(jobId) {
  const { data, error } = await admin
    .from("report_jobs")
    .select("id, inspection_sk, org_sk, user_id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`loadJob: ${error.message}`);
  return data;
}

export async function setJobStatus(jobId, fields) {
  const { error } = await admin
    .from("report_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`setJobStatus: ${error.message}`);
}

// Same bucket + path convention as the generate-report Edge Function.
export function buildStoragePath({ orgId, userId, inspectionId }) {
  return `${orgId ?? "no-org"}/${userId}/${inspectionId}/${Date.now()}.pdf`;
}

export async function uploadReport(storagePath, bytes) {
  const { error } = await admin.storage
    .from(REPORT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (error) throw new Error(`uploadReport: ${error.message}`);
}

export async function signReport(storagePath) {
  const { data, error } = await admin.storage
    .from(REPORT_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (error || !data?.signedUrl) {
    throw new Error(`signReport: ${error?.message ?? "no signed url"}`);
  }
  return data.signedUrl;
}

// Mirror generate-report's inspection_reports record so the canonical "a report
// was generated" history stays in one table. Non-fatal: the PDF + report_jobs
// row are the user-facing artifacts, so we log and continue if this insert
// fails.
export async function recordReport({
  inspectionId,
  orgId,
  userId,
  storagePath,
  sizeBytes,
  pageCount = 1,
}) {
  const { error } = await admin.from("inspection_reports").insert({
    inspection_sk: inspectionId,
    org_sk: orgId ?? null,
    user_id: userId,
    storage_path: storagePath,
    page_count: pageCount,
    size_bytes: sizeBytes,
    generated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[worker] recordReport (inspection_reports) failed:", error.message);
  }
}

// Server-side error sink. Best-effort — logging must never throw.
export async function logToCloud({
  level = "error",
  message,
  context,
  stack,
  jobId,
  userId,
  source = "report-worker",
}) {
  try {
    await admin.from("app_logs").insert({
      level,
      message: message ?? null,
      context: context ?? null,
      stack: stack ?? null,
      job_id: jobId ?? null,
      user_id: userId ?? null,
      source,
    });
  } catch (e) {
    console.error("[worker] logToCloud failed:", e?.message);
  }
}
