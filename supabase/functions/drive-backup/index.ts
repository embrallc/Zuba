// drive-backup Edge Function — the whole-record Drive mirror runner.
//
// ⭐ THE UNIT OF WORK IS ONE INSPECTION, NOT ONE FILE. Every run re-derives what
// the inspector's Drive folder SHOULD contain from the current state of the
// completed inspection, diffs that against our file ledger, and converges:
// create what's missing, overwrite what changed, trash what's gone. That's what
// makes the restore → edit → complete-again loop (and a plain re-Generate) land
// on "Drive equals the record" instead of piling up duplicates.
//
// Because the diff is DECLARATIVE, a run that dies halfway is always safe to
// re-run from scratch — nothing depends on where the previous pass stopped.
//
// Auth: service-role bearer only (the DB trigger, the cron sweep, drive-manage,
// and this function's own continuation). Never called from a device.
//
// Body: { inspectionSk, depth?: number }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logCloudEvent } from "../_shared/logToCloud.ts";
import { renderReportHtml } from "../_shared/renderReportHtml.js";
import {
  createFolder,
  DriveError,
  getFolder,
  mintAccessToken,
  sanitizeName,
  trashFile,
  updateFileContent,
  updateFolderPlacement,
  uploadFile,
} from "../_shared/googleDrive.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[drive-backup]";
const SOURCE = "ef:drive-backup";

const PHOTO_BUCKET = "inspection-images";
const REPORT_BUCKET = Deno.env.get("REPORT_BUCKET") ?? "inspection-reports";
const ROOT_FOLDER_NAME = "Zanbi Inspections";

// Batch limits. An Edge Function has a wall-clock ceiling, so a 100-photo
// inspection is deliberately spread across several invocations that hand off to
// each other; the cron sweep re-drives anything that still falls through.
const BATCH_SIZE = 10;
const TIME_BUDGET_MS = 45_000;
const MAX_DEPTH = 20;
const UPLOAD_CONCURRENCY = 3;
const MAX_ATTEMPTS = 5;

// The archived interactive report embeds its photos as data: URIs so the file
// still renders years from now with no signed URLs, no network, and no
// dependence on its sibling files. That means holding the base64 in memory, so
// it's capped: past this many ORIGINAL photo bytes the remaining images fall
// back to relative Raw_Photos/ links and the page says so. ~20 MB covers a
// typical inspection outright while leaving plenty of headroom under the
// function's memory ceiling.
const HTML_EMBED_BUDGET_BYTES = 20 * 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(`${TAG} ${event}`, JSON.stringify(fields));
}
function logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error: err instanceof Error ? err.message : (anyErr?.message ?? String(err)),
      kind: (err as DriveError)?.kind,
    }),
  );
}

// ── Naming ───────────────────────────────────────────────────────────────────
function inspectionDate(insp: Record<string, unknown>): Date {
  const raw = (insp?.scheduled_at ?? insp?.created_at) as string | null;
  const d = raw ? new Date(raw) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

function fmtParts(date: Date, tz: string | null) {
  // The folder label should read in the inspector's own business timezone —
  // an evening inspection shouldn't file itself under tomorrow.
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const yearOpts: Intl.DateTimeFormatOptions = { year: "numeric" };
  if (tz) {
    opts.timeZone = tz;
    yearOpts.timeZone = tz;
  }
  try {
    return {
      monthDay: new Intl.DateTimeFormat("en-US", opts).format(date),
      year: new Intl.DateTimeFormat("en-US", yearOpts).format(date),
    };
  } catch (_) {
    return {
      monthDay: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
        .format(date),
      year: String(date.getUTCFullYear()),
    };
  }
}

function folderLabel(insp: Record<string, unknown>, tz: string | null): string {
  const addr = [insp?.address_line1, insp?.city].filter(Boolean).join(", ");
  const who = (insp?.full_name as string) ?? "";
  const { monthDay } = fmtParts(inspectionDate(insp), tz);
  const head = addr || who || "Inspection";
  const tail = addr && who ? ` - ${who}` : "";
  return sanitizeName(`${head}${tail} (${monthDay})`);
}

function reportSlug(insp: Record<string, unknown>): string {
  const addr = (insp?.address_line1 as string) ?? "";
  const slug = sanitizeName(addr || (insp?.full_name as string) || "Inspection", 60)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "Inspection";
}

function reportFileName(insp: Record<string, unknown>): string {
  return `Final_Report_${reportSlug(insp)}.pdf`;
}

// Report Types means an org (or one inspection) can produce a PDF, the
// interactive online report, or both. Whichever the CLIENT got, the archive gets
// — so an online-only org still ends up with a readable report in their Drive,
// not just photos and a JSON file.
function reportHtmlFileName(insp: Record<string, unknown>): string {
  return `Interactive_Report_${reportSlug(insp)}.html`;
}

// Chunked so a large photo can't blow the argument limit of String.fromCharCode.
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── Photo enumeration ────────────────────────────────────────────────────────
// Same shape the report renderer walks (answers.sections[].instances[].fields[]
// arrays of {id, cloudUri}), plus the scanner's per-scan tag photos. We archive
// the ORIGINAL, and additionally the marked-up copy when one exists — "all
// pictures taken" means the raw evidence AND the annotated version.
type DesiredPhoto = { key: string; photoId: string; path: string; marked: boolean };

function collectPhotos(answers: Record<string, unknown> | null): DesiredPhoto[] {
  const out: DesiredPhoto[] = [];
  const seen = new Set<string>();
  const push = (p: unknown) => {
    const ref = p as Record<string, string> | null;
    if (!ref || typeof ref !== "object" || !ref.id || !ref.cloudUri) return;
    if (!seen.has(ref.id)) {
      seen.add(ref.id);
      out.push({
        key: `photo:${ref.id}`,
        photoId: ref.id,
        path: ref.cloudUri,
        marked: false,
      });
    }
    const burned = ref.burnedCloudUri;
    if (burned && !seen.has(`${ref.id}:marked`)) {
      seen.add(`${ref.id}:marked`);
      out.push({
        key: `photo:${ref.id}:marked`,
        photoId: ref.id,
        path: burned,
        marked: true,
      });
    }
  };

  const sections = (answers?.sections ?? {}) as Record<string, Record<string, unknown>>;
  for (const sec of Object.values(sections ?? {})) {
    for (const inst of ((sec?.instances ?? []) as Record<string, unknown>[])) {
      for (const val of Object.values((inst?.fields ?? {}) as Record<string, unknown>)) {
        if (Array.isArray(val)) for (const p of val) push(p);
      }
      for (const scan of ((inst?.scans ?? []) as Record<string, unknown>[])) {
        push(scan?.photo);
      }
    }
  }
  return out;
}

// ── Small concurrency pool ───────────────────────────────────────────────────
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function backoffAt(attempts: number): string {
  const minutes = Math.min(2 ** Math.max(attempts, 0), 60);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const startedAt = Date.now();
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt !== serviceKey) return json({ error: "unauthorized" }, 401);

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: { inspectionSk?: string; depth?: number } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const inspectionSk = body.inspectionSk;
  const depth = Number.isFinite(body.depth) ? Number(body.depth) : 0;
  if (!inspectionSk) return json({ error: "missing_inspection" }, 400);

  // ── Load the job ───────────────────────────────────────────────────────────
  const { data: sync, error: syncErr } = await admin
    .from("drive_syncs")
    .select("inspection_sk, org_sk, status, attempts, resync_requested")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (syncErr) {
    logError("sync_lookup_failed", syncErr, { inspectionSk });
    return json({ error: "db_error" }, 500);
  }
  if (!sync) return json({ ok: true, skipped: "no_sync_row" });
  const orgSk = sync.org_sk as string;

  const { data: conn, error: connErr } = await admin
    .from("drive_connections")
    .select("org_sk, status, backup_enabled")
    .eq("org_sk", orgSk)
    .maybeSingle();
  if (connErr) {
    logError("connection_lookup_failed", connErr, { inspectionSk, orgSk });
    return json({ error: "db_error" }, 500);
  }
  if (!conn || conn.status !== "connected" || conn.backup_enabled !== true) {
    logInfo("skip_not_connected", { inspectionSk, orgSk, status: conn?.status });
    return json({ ok: true, skipped: "not_connected" });
  }

  // ── Claim ──────────────────────────────────────────────────────────────────
  // depth 0 = a fresh nudge, so take the claim (only one runner wins). depth > 0
  // = our own continuation, which already holds it; just beat the heartbeat.
  const nowIso = new Date().toISOString();
  if (depth === 0) {
    const { data: claimed, error: claimErr } = await admin
      .from("drive_syncs")
      .update({
        status: "running",
        claimed_at: nowIso,
        attempts: (sync.attempts ?? 0) + 1,
        updated_at: nowIso,
      })
      .eq("inspection_sk", inspectionSk)
      .in("status", ["pending", "failed"])
      .select("inspection_sk");
    if (claimErr) {
      logError("claim_failed", claimErr, { inspectionSk });
      return json({ error: "db_error" }, 500);
    }
    if (!claimed || claimed.length === 0) {
      logInfo("skip_already_running", { inspectionSk, status: sync.status });
      return json({ ok: true, skipped: "already_running" });
    }
  } else {
    await admin
      .from("drive_syncs")
      .update({ claimed_at: nowIso, updated_at: nowIso })
      .eq("inspection_sk", inspectionSk);
  }

  const attempts = (sync.attempts ?? 0) + (depth === 0 ? 1 : 0);

  // Park the job for a later pass. Every failure path funnels through here so
  // the state transition + logging stay consistent.
  async function fail(reason: string, opts: { retry: boolean } = { retry: true }) {
    await admin
      .from("drive_syncs")
      .update({
        status: "failed",
        last_error: reason,
        attempts: opts.retry ? attempts : MAX_ATTEMPTS, // burn the budget = stop retrying
        next_attempt_at: opts.retry ? backoffAt(attempts) : backoffAt(MAX_ATTEMPTS),
        updated_at: new Date().toISOString(),
      })
      .eq("inspection_sk", inspectionSk);
    void logCloudEvent(admin, SOURCE, "drive.sync_failed", {
      data: { inspectionSk, reason, retry: opts.retry },
      orgSk,
    });
  }

  try {
    // ── Load the record we're mirroring ──────────────────────────────────────
    const { data: insp, error: inspErr } = await admin
      .from("inspections")
      .select(
        "inspection_sk, user_id, org_sk, status, full_name, address_line1, address_line2, " +
          "city, state, zip_code, email, phone, scheduled_at, summary, paid, payment_state, " +
          "report_state, created_at",
      )
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();
    if (inspErr) throw inspErr;
    if (!insp) {
      await fail("Inspection no longer exists.", { retry: false });
      return json({ ok: true, skipped: "inspection_missing" });
    }
    // Reopened between the nudge and now — leave Drive exactly as it is until it
    // is completed again (that completion will queue a fresh sync).
    if ((insp.status ?? "OPEN") !== "CLOSED") {
      await admin
        .from("drive_syncs")
        .update({
          status: "done",
          last_error: null,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("inspection_sk", inspectionSk);
      logInfo("skip_reopened", { inspectionSk });
      return json({ ok: true, skipped: "not_closed" });
    }

    const { data: org } = await admin
      .from("organizations")
      .select("timezone, org_name")
      .eq("org_sk", orgSk)
      .maybeSingle();
    const tz = (org?.timezone as string | null) ?? null;

    const { data: form } = await admin
      .from("inspection_forms")
      .select("answers, schema_snapshot, template_version")
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();

    const { data: report } = await admin
      .from("inspection_reports")
      .select("report_sk, storage_path, model_path, page_count, size_bytes, generated_at")
      .eq("inspection_sk", inspectionSk)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: payments } = await admin
      .from("payment_requests")
      .select("amount_cents, currency, status, paid_at")
      .eq("inspection_sk", inspectionSk)
      .order("created_at", { ascending: false })
      .limit(1);
    const payment = payments?.[0] ?? null;

    // ── Access token ─────────────────────────────────────────────────────────
    const { data: refreshToken, error: vaultErr } = await admin.rpc(
      "drive_secret_get",
      { p_org_sk: orgSk },
    );
    if (vaultErr || typeof refreshToken !== "string" || !refreshToken) {
      logError("vault_get_failed", vaultErr ?? new Error("no token"), { orgSk });
      await admin
        .from("drive_connections")
        .update({
          status: "revoked",
          last_error: "The Google Drive connection is missing. Please reconnect.",
          updated_at: new Date().toISOString(),
        })
        .eq("org_sk", orgSk);
      await fail("Google Drive is not connected. Please reconnect.", { retry: false });
      return json({ ok: false, error: "no_token" });
    }
    const token = await mintAccessToken(refreshToken);

    // ── Folder chain (create / rename / move) ────────────────────────────────
    const { year } = fmtParts(inspectionDate(insp), tz);
    const label = folderLabel(insp, tz);

    const { data: folderRows } = await admin
      .from("drive_folders")
      .select("path_key, drive_folder_id, name, parent_key")
      .eq("org_sk", orgSk)
      .in("path_key", [
        "root",
        `year:${year}`,
        `insp:${inspectionSk}`,
        `insp:${inspectionSk}/photos`,
      ]);
    const cache = new Map(
      (folderRows ?? []).map((r) => [r.path_key as string, r]),
    );

    // Resolve one folder: reuse the remembered id when Drive still has it,
    // otherwise recreate. `drive.file` only sees folders WE made, so a 404 means
    // the inspector deleted it — recreating is the right, self-healing answer.
    async function ensureFolder(
      pathKey: string,
      name: string,
      parentId: string | null,
      parentKey: string | null,
    ): Promise<string> {
      const row = cache.get(pathKey);
      if (row?.drive_folder_id) {
        const live = await getFolder(token, row.drive_folder_id as string);
        if (live && !live.trashed) {
          const needsRename = live.name !== name;
          const needsMove = !!parentId && !live.parents.includes(parentId);
          if (needsRename || needsMove) {
            await updateFolderPlacement(token, live.id, {
              name: needsRename ? name : undefined,
              addParent: needsMove ? parentId! : undefined,
              removeParent: needsMove ? live.parents?.[0] : undefined,
            });
            logInfo("folder_relocated", { pathKey, needsRename, needsMove });
          }
          if (needsRename || needsMove || row.parent_key !== parentKey) {
            await admin
              .from("drive_folders")
              .update({ name, parent_key: parentKey, updated_at: new Date().toISOString() })
              .eq("org_sk", orgSk)
              .eq("path_key", pathKey);
          }
          return live.id;
        }
      }
      const created = await createFolder(token, name, parentId);
      await admin.from("drive_folders").upsert(
        {
          org_sk: orgSk,
          path_key: pathKey,
          drive_folder_id: created,
          name,
          parent_key: parentKey,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_sk,path_key" },
      );
      cache.set(pathKey, {
        path_key: pathKey,
        drive_folder_id: created,
        name,
        parent_key: parentKey,
      });
      return created;
    }

    const rootId = await ensureFolder("root", ROOT_FOLDER_NAME, null, null);
    const yearId = await ensureFolder(`year:${year}`, year, rootId, "root");
    const inspId = await ensureFolder(
      `insp:${inspectionSk}`,
      label,
      yearId,
      `year:${year}`,
    );
    const photosId = await ensureFolder(
      `insp:${inspectionSk}/photos`,
      "Raw_Photos",
      inspId,
      `insp:${inspectionSk}`,
    );

    // ── Desired file set ─────────────────────────────────────────────────────
    const answers = (form?.answers ?? {}) as Record<string, unknown>;
    const photos = collectPhotos(answers);

    type Task = {
      artifact: string;
      name: string;
      parentId: string;
      mimeType: string;
      bucket: string;
      sourcePath: string | null;
      inlineBody?: Uint8Array;
      // Lazy body. Only called when this artifact is actually being written, so
      // an expensive build (the interactive report downloads + embeds photos)
      // never runs on an invocation that isn't going to use it.
      build?: () => Promise<Uint8Array>;
      alwaysWrite: boolean;
    };

    const tasks: Task[] = [];

    if (report?.storage_path) {
      tasks.push({
        artifact: "report_pdf",
        name: reportFileName(insp),
        parentId: inspId,
        mimeType: "application/pdf",
        bucket: REPORT_BUCKET,
        sourcePath: report.storage_path as string,
        // Derived from the whole record, so always assumed stale.
        alwaysWrite: true,
      });
    }

    const record = {
      exportedAt: new Date().toISOString(),
      exportVersion: 1,
      organization: { orgSk, name: org?.org_name ?? null, timezone: tz },
      inspection: {
        inspectionSk: insp.inspection_sk,
        client: insp.full_name ?? null,
        email: insp.email ?? null,
        phone: insp.phone ?? null,
        address: {
          line1: insp.address_line1 ?? null,
          line2: insp.address_line2 ?? null,
          city: insp.city ?? null,
          state: insp.state ?? null,
          zip: insp.zip_code ?? null,
        },
        scheduledAt: insp.scheduled_at ?? null,
        createdAt: insp.created_at ?? null,
        status: insp.status ?? null,
        summary: insp.summary ?? null,
        inspectorUserId: insp.user_id ?? null,
      },
      payment: payment
        ? {
          amountCents: payment.amount_cents ?? null,
          currency: payment.currency ?? null,
          status: payment.status ?? null,
          paidAt: payment.paid_at ?? null,
          paid: insp.paid === true,
        }
        : { paid: insp.paid === true },
      report: report
        ? {
          generatedAt: report.generated_at ?? null,
          pageCount: report.page_count ?? null,
          sizeBytes: report.size_bytes ?? null,
          // Which artifacts this inspection actually produced — an org can have
          // PDF, the interactive online report, or both.
          pdfFileName: report.storage_path ? reportFileName(insp) : null,
          htmlFileName: report.model_path ? reportHtmlFileName(insp) : null,
        }
        : null,
      walkthrough: {
        templateVersion: form?.template_version ?? null,
        schema: form?.schema_snapshot ?? null,
        answers,
      },
      photos: photos.map((p, i) => ({
        photoId: p.photoId,
        marked: p.marked,
        fileName: photoFileName(i, p),
      })),
    };

    tasks.push({
      artifact: "data_json",
      name: "inspection_data.json",
      parentId: inspId,
      mimeType: "application/json",
      bucket: "",
      sourcePath: null,
      inlineBody: new TextEncoder().encode(JSON.stringify(record, null, 2)),
      alwaysWrite: true,
    });

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      tasks.push({
        artifact: p.key,
        name: photoFileName(i, p),
        parentId: photosId,
        mimeType: "image/jpeg",
        bucket: PHOTO_BUCKET,
        sourcePath: p.path,
        alwaysWrite: false,
      });
    }

    // The interactive report, archived as ONE self-contained HTML file. Pushed
    // last so it's written after Raw_Photos exists (its overflow images link
    // there). Only produced when this inspection actually made an online report
    // — an org with Online turned off never gets a stray empty file, and an org
    // with PDF turned off is no longer left without a readable report.
    if (report?.model_path) {
      const modelPath = report.model_path as string;
      // Model photo paths are `burnedCloudUri ?? cloudUri`, the same values we
      // archived — so this maps each one onto the name it has in Raw_Photos.
      const nameBySourcePath = new Map(
        photos.map((p, i) => [p.path, photoFileName(i, p)]),
      );

      tasks.push({
        artifact: "report_html",
        name: reportHtmlFileName(insp),
        parentId: inspId,
        mimeType: "text/html",
        bucket: "",
        sourcePath: modelPath,
        alwaysWrite: true,
        build: async () => {
          const { data: blob, error } = await admin.storage
            .from(REPORT_BUCKET)
            .download(modelPath);
          if (error || !blob) throw error ?? new Error("model.json missing");
          const model = JSON.parse(await blob.text());

          // Inline each photo as a data: URI, within the memory budget. The
          // live viewers mint short-lived signed URLs here — right for a viewer,
          // wrong for an archive, since the file would render broken the moment
          // they expired.
          const dataUris = new Map<string, string>();
          let embedded = 0;
          let overflow = 0;
          const modelPaths = new Set<string>();
          for (const sec of model?.sections ?? []) {
            for (const inst of sec?.instances ?? []) {
              for (const ph of inst?.photos ?? []) {
                if (ph?.path) modelPaths.add(ph.path as string);
              }
            }
          }
          for (const path of modelPaths) {
            if (embedded >= HTML_EMBED_BUDGET_BYTES) {
              overflow++;
              continue;
            }
            try {
              const { data: img, error: imgErr } = await admin.storage
                .from(PHOTO_BUCKET)
                .download(path);
              if (imgErr || !img) throw imgErr ?? new Error("empty download");
              const buf = new Uint8Array(await img.arrayBuffer());
              embedded += buf.length;
              dataUris.set(path, `data:image/jpeg;base64,${toBase64(buf)}`);
            } catch (e) {
              // One unreadable photo degrades to a placeholder tile; the report
              // still archives.
              overflow++;
              logError("html_photo_embed_failed", e, { inspectionSk, path });
            }
          }

          let html: string = renderReportHtml(model, {
            photosPerRow: "auto",
            photoSrc: (p: { path?: string }) => {
              if (!p?.path) return null;
              const inline = dataUris.get(p.path);
              if (inline) return inline;
              const fileName = nameBySourcePath.get(p.path);
              // Not embedded: point at the sibling copy, which works whenever
              // the folder is downloaded intact.
              return fileName ? `Raw_Photos/${encodeURIComponent(fileName)}` : null;
            },
          });

          if (overflow > 0) {
            const note =
              `<div style="font:600 13px/1.5 system-ui,sans-serif;background:#FEF3C7;` +
              `color:#7C2D12;padding:12px 16px;border-bottom:1px solid #FDE68A">` +
              `${overflow} photo${overflow === 1 ? "" : "s"} in this report ` +
              `${overflow === 1 ? "is" : "are"} not embedded in this file. ` +
              `Keep it in the same folder as <strong>Raw_Photos</strong> to see ` +
              `${overflow === 1 ? "it" : "them"}.</div>`;
            html = html.replace("<body>", `<body>${note}`);
          }
          logInfo("html_built", {
            inspectionSk,
            embeddedBytes: embedded,
            overflow,
          });
          return new TextEncoder().encode(html);
        },
      });
    }

    // ── Diff against the ledger ──────────────────────────────────────────────
    const { data: ledgerRows } = await admin
      .from("drive_backups")
      .select("artifact, source_path, drive_file_id, status, attempts")
      .eq("inspection_sk", inspectionSk);
    const ledger = new Map(
      (ledgerRows ?? []).map((r) => [r.artifact as string, r]),
    );

    const desiredKeys = new Set(tasks.map((t) => t.artifact));
    const todo = tasks.filter((t) => {
      const row = ledger.get(t.artifact);
      if (!row) return true;
      if (row.status === "failed" && (row.attempts ?? 0) >= MAX_ATTEMPTS) return false;
      if (row.status !== "done") return true;
      if (t.alwaysWrite) return true;
      // A stored photo object is immutable (markup writes a NEW path), so an
      // unchanged source_path proves the Drive copy already matches. This is what
      // stops a re-Generate from re-pushing every photo for nothing.
      return row.source_path !== t.sourcePath;
    });

    // Anything we previously mirrored that is no longer part of the record.
    const toTrash = (ledgerRows ?? []).filter(
      (r) =>
        String(r.artifact).startsWith("photo:") &&
        r.status === "done" &&
        r.drive_file_id &&
        !desiredKeys.has(r.artifact as string),
    );

    const totalWork = todo.length + toTrash.length;
    logInfo("plan", {
      inspectionSk,
      depth,
      photos: photos.length,
      todo: todo.length,
      trash: toTrash.length,
    });

    // ── Apply one batch ──────────────────────────────────────────────────────
    let processed = 0;
    let hardStop: { reason: string; retry: boolean } | null = null;

    const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

    const trashBatch = toTrash.slice(0, BATCH_SIZE);
    for (const row of trashBatch) {
      if (overBudget() || hardStop) break;
      try {
        await trashFile(token, row.drive_file_id as string);
        await admin
          .from("drive_backups")
          .update({ status: "trashed", updated_at: new Date().toISOString() })
          .eq("inspection_sk", inspectionSk)
          .eq("artifact", row.artifact as string);
        processed++;
        logInfo("trashed", { inspectionSk, artifact: row.artifact });
      } catch (e) {
        if (e instanceof DriveError && (e.kind === "auth" || e.kind === "quota")) {
          hardStop = { reason: e.message, retry: false };
          break;
        }
        logError("trash_failed", e, { inspectionSk, artifact: row.artifact });
      }
    }

    const workBatch = todo.slice(0, Math.max(BATCH_SIZE - processed, 0));
    await runPool(workBatch, UPLOAD_CONCURRENCY, async (task) => {
      if (overBudget() || hardStop) return;
      const existing = ledger.get(task.artifact);
      try {
        // Bytes: either built here (the JSON record) or pulled from Storage with
        // the service role — no signed URLs needed server-side.
        let bytes = task.inlineBody ?? null;
        if (!bytes && task.build) bytes = await task.build();
        if (!bytes && task.sourcePath) {
          const { data: blob, error: dlErr } = await admin.storage
            .from(task.bucket)
            .download(task.sourcePath);
          if (dlErr || !blob) throw dlErr ?? new Error("empty download");
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        if (!bytes) throw new Error("nothing to upload");

        // A previously TRASHED artifact that's part of the record again (an undo,
        // or a photo re-attached) must become a NEW file — updating the trashed
        // one would write bytes nobody can see, since it stays in the trash.
        let fileId = existing?.status === "trashed"
          ? null
          : ((existing?.drive_file_id as string | null) ?? null);
        if (fileId) {
          try {
            await updateFileContent(token, fileId, {
              mimeType: task.mimeType,
              bytes,
            });
          } catch (e) {
            // The inspector deleted our file — make a new one rather than fail.
            if (e instanceof DriveError && e.kind === "not_found") fileId = null;
            else throw e;
          }
        }
        if (!fileId) {
          fileId = await uploadFile(token, {
            name: task.name,
            parentId: task.parentId,
            mimeType: task.mimeType,
            bytes,
          });
        }

        await admin.from("drive_backups").upsert(
          {
            org_sk: orgSk,
            inspection_sk: inspectionSk,
            artifact: task.artifact,
            source_path: task.sourcePath,
            drive_file_id: fileId,
            status: "done",
            attempts: 0,
            last_error: null,
            backed_up_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "inspection_sk,artifact" },
        );
        processed++;
      } catch (e) {
        // Connection-level problems stop the whole run; a single bad file does not.
        if (e instanceof DriveError && (e.kind === "auth" || e.kind === "quota")) {
          hardStop = { reason: e.message, retry: false };
          if (e.kind === "auth") {
            await admin
              .from("drive_connections")
              .update({
                status: "revoked",
                last_error:
                  "Zanbi's access to your Google Drive was revoked. Please reconnect.",
                updated_at: new Date().toISOString(),
              })
              .eq("org_sk", orgSk);
          } else {
            await admin
              .from("drive_connections")
              .update({
                last_error: "Your Google Drive is full — backups are paused.",
                updated_at: new Date().toISOString(),
              })
              .eq("org_sk", orgSk);
          }
          return;
        }
        const nextAttempts = ((existing?.attempts as number) ?? 0) + 1;
        const message = e instanceof Error ? e.message : String(e);
        logError("file_failed", e, {
          inspectionSk,
          artifact: task.artifact,
          attempts: nextAttempts,
        });
        await admin.from("drive_backups").upsert(
          {
            org_sk: orgSk,
            inspection_sk: inspectionSk,
            artifact: task.artifact,
            source_path: task.sourcePath,
            drive_file_id: (existing?.drive_file_id as string | null) ?? null,
            status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts: nextAttempts,
            last_error: message,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "inspection_sk,artifact" },
        );
      }
    });

    if (hardStop) {
      await fail(hardStop.reason, { retry: hardStop.retry });
      logInfo("hard_stop", { inspectionSk, reason: hardStop.reason });
      return json({ ok: false, error: "stopped", reason: hardStop.reason });
    }

    const remaining = totalWork - processed;

    // ── Finish, or hand off to the next batch ────────────────────────────────
    if (remaining > 0 && depth < MAX_DEPTH) {
      await admin
        .from("drive_syncs")
        .update({
          files_done: processed,
          files_total: totalWork,
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("inspection_sk", inspectionSk);
      // Fire-and-forget continuation; the cron sweep covers us if it drops.
      void fetch(`${url}/functions/v1/drive-backup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inspectionSk, depth: depth + 1 }),
      }).catch((e) => logError("continuation_failed", e, { inspectionSk }));
      logInfo("batch_done_continuing", { inspectionSk, processed, remaining, depth });
      return json({ ok: true, processed, remaining, continuing: true });
    }

    if (remaining > 0) {
      // Depth exhausted (a pathologically large inspection) — park it for cron
      // rather than chaining forever.
      await fail(`Backup is taking multiple passes (${remaining} files left).`);
      return json({ ok: true, processed, remaining, parked: true });
    }

    // A report record landed while we were running — go again so Drive ends up
    // matching the NEWER state rather than the one we just finished mirroring.
    const { data: fresh } = await admin
      .from("drive_syncs")
      .select("resync_requested")
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();

    // Partial success is still success — one unreadable photo must not hold the
    // whole record hostage — but the owner deserves to SEE that it happened.
    const { count: stuckFiles } = await admin
      .from("drive_backups")
      .select("artifact", { count: "exact", head: true })
      .eq("inspection_sk", inspectionSk)
      .eq("status", "failed");
    const partialNote = stuckFiles
      ? `${stuckFiles} file${stuckFiles === 1 ? "" : "s"} couldn't be backed up.`
      : null;

    const finishedAt = new Date().toISOString();
    await admin
      .from("drive_syncs")
      .update({
        status: fresh?.resync_requested ? "pending" : "done",
        resync_requested: false,
        attempts: 0,
        last_error: partialNote,
        files_done: processed,
        files_total: totalWork,
        synced_at: finishedAt,
        next_attempt_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("inspection_sk", inspectionSk);

    await admin
      .from("drive_connections")
      .update({ last_backup_at: finishedAt, last_error: null, updated_at: finishedAt })
      .eq("org_sk", orgSk);

    if (fresh?.resync_requested) {
      void fetch(`${url}/functions/v1/drive-backup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inspectionSk }),
      }).catch(() => {});
    }

    logInfo("sync_complete", { inspectionSk, processed, totalWork, depth });
    void logCloudEvent(admin, SOURCE, "drive.sync_complete", {
      data: { inspectionSk, files: processed, photos: photos.length },
      orgSk,
    });
    return json({ ok: true, processed, remaining: 0 });
  } catch (e) {
    // DriveError carries the retry decision; anything else gets a normal backoff.
    const kind = (e as DriveError)?.kind;
    const message = e instanceof Error ? e.message : String(e);
    logError("sync_failed", e, { inspectionSk, orgSk, depth });
    if (kind === "auth") {
      await admin
        .from("drive_connections")
        .update({
          status: "revoked",
          last_error:
            "Zanbi's access to your Google Drive was revoked. Please reconnect.",
          updated_at: new Date().toISOString(),
        })
        .eq("org_sk", orgSk);
      await fail("Google Drive access was revoked. Please reconnect.", { retry: false });
    } else if (kind === "quota") {
      await fail("Your Google Drive is full.", { retry: false });
    } else {
      await fail(message);
    }
    return json({ ok: false, error: "sync_failed", detail: message }, 200);
  }
});

// Photo file names are assigned at CREATION from the current index and never
// rewritten, so deleting a photo later leaves a gap (Photo_001, Photo_003)
// rather than silently renaming every other file in the inspector's archive.
function photoFileName(index: number, p: DesiredPhoto): string {
  const n = String(index + 1).padStart(3, "0");
  return p.marked ? `Photo_${n}_marked.jpg` : `Photo_${n}.jpg`;
}
