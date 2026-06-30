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
import { admin, getUserFromJwt, isConfigured } from "./lib/supabase.js";

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

// POST /api/render-internal
// Body: { inspectionSk, tzOffsetMinutes? }   Header: Authorization: Bearer <SERVICE_ROLE_KEY>
//
// Server-to-server render for the auto-send-on-complete path (the
// send-report-to-client Edge Function). Unlike /api/generate-report this has NO
// user JWT and NO report_jobs row — auth is the service-role key both sides hold
// — and it renders SYNCHRONOUSLY, returning the storage path so the caller can
// sign + email it. The PDF + inspection_reports audit row are produced exactly
// like the job path (same renderer), so a later manual view/restore finds it.
app.post("/api/render-internal", async (req, res) => {
  if (!isConfigured) {
    return res.status(503).json({
      error: "server_misconfigured",
      detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set on the worker",
    });
  }

  // Auth: the bearer must be the service-role key (trusted server-to-server).
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { inspectionSk } = req.body ?? {};
  const tzOffsetMin = Number.isFinite(req.body?.tzOffsetMinutes)
    ? Number(req.body.tzOffsetMinutes)
    : 0;
  if (!inspectionSk) {
    return res.status(400).json({ error: "missing_fields", required: ["inspectionSk"] });
  }

  try {
    // Resolve the owner + org from the inspection (service role).
    const { data: insp, error: inspErr } = await admin
      .from("inspections")
      .select("user_id")
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();
    if (inspErr) throw new Error(`inspection lookup: ${inspErr.message}`);
    if (!insp) return res.status(404).json({ error: "inspection_not_found" });
    const userId = insp.user_id;
    let orgId = null;
    if (userId) {
      const { data: u } = await admin
        .from("users")
        .select("org_sk")
        .eq("id", userId)
        .maybeSingle();
      orgId = u?.org_sk ?? null;
    }

    const { bytes, pageCount } = await renderInspectionReport({
      inspectionSk,
      userId,
      orgSk: orgId,
      tzOffsetMin,
    });
    const storagePath = buildStoragePath({ orgId, userId, inspectionId: inspectionSk });
    await uploadReport(storagePath, bytes);
    await recordReport({
      inspectionId: inspectionSk,
      orgId,
      userId,
      storagePath,
      sizeBytes: bytes.length,
      pageCount,
    });
    return res.status(200).json({
      storagePath,
      pageCount,
      sizeBytes: bytes.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e?.message ?? String(e);
    console.error(`[worker] render-internal FAILED (${inspectionSk}):`, message);
    await logToCloud({
      message,
      context: `render-internal inspection=${inspectionSk}`,
      stack: e?.stack,
    });
    return res.status(500).json({ error: "render_failed", detail: message });
  }
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
