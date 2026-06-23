import express from "express";
import { buildMockPdf } from "./lib/pdf.js";
import {
  buildStoragePath,
  loadJob,
  logToCloud,
  recordReport,
  setJobStatus,
  signReport,
  uploadReport,
} from "./lib/jobs.js";
import { getUserFromJwt } from "./lib/supabase.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Cloud Run health check.
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// POST /api/generate-report
// Body: { jobId, inspectionId, orgId }   Header: Authorization: Bearer <user JWT>
//
// Handshake rule: validate, mark the job 'processing', and respond 202
// IMMEDIATELY. The heavy PDF work runs DETACHED (generateInBackground) so the
// caller's connection clears instantly. NOTE: on Cloud Run this requires
// --no-cpu-throttling, otherwise CPU is frozen after the response and the
// background work never finishes.
app.post("/api/generate-report", async (req, res) => {
  // 1. Validate body.
  const { jobId, inspectionId, orgId } = req.body ?? {};
  if (!jobId || !inspectionId || !orgId) {
    return res.status(400).json({
      error: "missing_fields",
      required: ["jobId", "inspectionId", "orgId"],
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

  // 5. Detached background generation.
  void generateInBackground({
    jobId,
    inspectionId,
    orgId,
    userId: user.id,
  });
});

async function generateInBackground({ jobId, inspectionId, orgId, userId }) {
  try {
    // Step A: (stub) fetch any extra inspection data. The mock doesn't need it;
    // the real renderer will pull the inspection + walkthrough form here.

    // Step B: build the PDF buffer.
    const bytes = await buildMockPdf({ inspectionId, orgId, jobId });

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
    });
    await setJobStatus(jobId, {
      status: "completed",
      report_url: reportUrl,
      storage_path: storagePath,
      error: null,
    });
    console.log(`[worker] job ${jobId} completed -> ${storagePath}`);
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
