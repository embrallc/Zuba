import express from "express";
import { renderInspectionReport } from "./lib/render.js";
import {
  buildStoragePath,
  loadJob,
  logToCloud,
  recordReport,
  setJobStatus,
  signReport,
  uploadReport,
} from "./lib/jobs.js";
import { getUserFromJwt, isConfigured } from "./lib/supabase.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check — also surfaces whether the Supabase creds are wired, so a
// misconfigured deploy is obvious at a glance instead of crash-looping.
app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, configured: isConfigured }),
);

// POST /api/generate-report
// Body: { jobId, inspectionId, orgId }   Header: Authorization: Bearer <user JWT>
//
// Handshake rule: validate, mark the job 'processing', and respond 202
// IMMEDIATELY. The heavy PDF work runs DETACHED (generateInBackground) so the
// caller's connection clears instantly. NOTE: on Cloud Run this requires
// --no-cpu-throttling, otherwise CPU is frozen after the response and the
// background work never finishes.
app.post("/api/generate-report", async (req, res) => {
  // 0. Config guard — clear 503 instead of a cryptic crash if creds are unset.
  if (!isConfigured) {
    return res.status(503).json({
      error: "server_misconfigured",
      detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set on the worker",
    });
  }

  // 1. Validate body. orgId is intentionally NOT trusted from the client — we
  // read it from the job row below. tzOffsetMinutes is optional (defaults to
  // UTC) and only affects how dates are formatted in the PDF.
  const { jobId, inspectionId } = req.body ?? {};
  const tzOffsetMin = Number.isFinite(req.body?.tzOffsetMinutes)
    ? Number(req.body.tzOffsetMinutes)
    : 0;
  if (!jobId || !inspectionId) {
    return res.status(400).json({
      error: "missing_fields",
      required: ["jobId", "inspectionId"],
    });
  }

  // 2. Validate the Supabase JWT.
  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = await getUserFromJwt(jwt);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  // 3. Authorize: the job must exist, belong to the caller, and match the body.
  let job;
  try {
    job = await loadJob(jobId);
  } catch (e) {
    console.error("[worker] loadJob failed:", e?.message);
    return res.status(500).json({ error: "job_lookup_failed" });
  }
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.user_id !== user.id) return res.status(403).json({ error: "forbidden" });
  if (job.inspection_sk !== inspectionId) {
    return res.status(400).json({ error: "inspection_mismatch" });
  }

  // 4. Mark processing + respond 202. Anything past here must NOT block the
  //    response.
  try {
    await setJobStatus(jobId, { status: "processing", error: null });
  } catch (e) {
    console.error("[worker] could not mark processing:", e?.message);
    return res.status(500).json({ error: "status_update_failed" });
  }
  res.status(202).json({ jobId, status: "processing" });

  // 5. Detached background generation. orgId comes from the job row (server
  // trusted); the renderer falls back to the user's profile org if it's null.
  void generateInBackground({
    jobId,
    inspectionId,
    orgId: job.org_sk ?? null,
    userId: user.id,
    tzOffsetMin,
  });
});

async function generateInBackground({ jobId, inspectionId, orgId, userId, tzOffsetMin }) {
  try {
    // Step A+B: fetch the inspection + walkthrough form + report layout and
    // render the PDF (photos downscaled with sharp). Throws ReportError with a
    // user-meaningful message for no-template / not-found cases.
    const { bytes, pageCount, skippedPhotos } = await renderInspectionReport({
      inspectionSk: inspectionId,
      userId,
      orgSk: orgId,
      tzOffsetMin,
    });

    // Step C: upload to the private bucket (service role).
    const storagePath = buildStoragePath({ orgId, userId, inspectionId });
    await uploadReport(storagePath, bytes);

    // Step D: time-limited signed URL (bucket is private — never public).
    const reportUrl = await signReport(storagePath);

    // Step E: record + complete.
    await recordReport({
      inspectionId,
      orgId,
      userId,
      storagePath,
      sizeBytes: bytes.length,
      pageCount,
    });
    await setJobStatus(jobId, {
      status: "completed",
      report_url: reportUrl,
      storage_path: storagePath,
      error: null,
    });
    console.log(
      `[worker] job ${jobId} completed -> ${storagePath} (${pageCount}p, skipped ${skippedPhotos} photo(s))`,
    );
  } catch (e) {
    const message = e?.message ?? String(e);
    console.error(`[worker] job ${jobId} FAILED:`, message);
    await logToCloud({
      message,
      context: `generate-report job=${jobId} inspection=${inspectionId}`,
      stack: e?.stack,
      jobId,
      userId,
    });
    try {
      await setJobStatus(jobId, { status: "failed", error: message });
    } catch (e2) {
      console.error(`[worker] could not mark job ${jobId} failed:`, e2?.message);
    }
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
