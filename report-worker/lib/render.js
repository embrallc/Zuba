// Real PDF report renderer — ported from the generate-report Edge Function.
//
// Same layout engine (pdf-lib, banded schema mirroring the Form Builder), but
// runs in Node on the worker so it isn't bound by the Edge Function's 256MB
// cap. Two changes vs the EF: (1) data fetch + Storage use the worker's
// service-role `admin` client instead of per-request Deno clients, and (2)
// inspection photos are downscaled with `sharp` before embedding (smaller
// PDFs + lower peak memory) and EXIF-rotated so portrait photos aren't sideways.
// Markup is burned onto a print-ready copy of the photo on-device (Skia); the
// ref carries `burnedCloudUri`, and we embed that copy when present (else clean).
//
// Entry point: renderInspectionReport({ inspectionSk, userId, orgSk, tzOffsetMin })
//   → { bytes: Uint8Array, pageCount, skippedPhotos, usedDraft, autoBuilt }
// Throws ReportError (with .code) for caller-meaningful failures (no template,
// not found) so the worker can surface a clear message on the job row.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { admin } from "./supabase.js";
import { walkthroughToReport } from "./shared/walkthroughToReport.js";
import { SEVERITY_LEVELS } from "./shared/walkthroughSchema.js";

const TAG = "[render]";

// ── Geometry (px @96dpi → pt @72dpi) ─────────────────────────────────────────
const PX2PT = 0.75;
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;
const MARGIN_PX = 48;
const PAGE_CONTENT_H_PX = 960;
const BAND_GAP_PX = 14;
const LINE_HEIGHT = 1.35;
const PHOTO_BUCKET = "inspection-images";
const ASSETS_BUCKET = "form-assets";
// Stop embedding photos past this budget (measured on the downscaled bytes that
// actually land in the PDF) so a 200-photo inspection can't blow memory; the
// report renders with the remaining photos and notes the rest were skipped.
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
// Longest edge for embedded inspection photos. A report renders at ~720px wide;
// 2000px keeps full-bleed photos crisp while cutting multi-MB camera originals
// to a few hundred KB.
const PHOTO_MAX_EDGE = 2000;

export class ReportError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

function logError(event, err, fields = {}) {
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error: err instanceof Error ? err.message : (err?.message ?? String(err)),
    }),
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function camelToSnake(s) {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function hexToRgb(hex, fallback = "#111827") {
  let h = (hex ?? fallback).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return hexToRgb(fallback);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDate(iso, tzOffsetMin, withTime) {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + tzOffsetMin * 60000);
  let out = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (withTime) {
    let h = d.getUTCHours();
    const m = d.getUTCMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    out += ` ${h}:${m} ${ampm}`;
  }
  return out;
}

function severityColor(value) {
  const v = (value ?? "").toLowerCase();
  for (const lvl of SEVERITY_LEVELS) {
    if (lvl.label.toLowerCase() === v || lvl.key.toLowerCase() === v) {
      return lvl.color;
    }
  }
  if (/(low|good|minor|ok)/.test(v)) return "#16A34A";
  if (/(med|moderate|fair)/.test(v)) return "#D97706";
  if (/(high|severe|critical|major|poor)/.test(v)) return "#DC2626";
  return null;
}

function roundedRectPath(w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  const k = 0.5523 * rr;
  return (
    `M ${rr} 0 L ${w - rr} 0 ` +
    `C ${w - rr + k} 0 ${w} ${rr - k} ${w} ${rr} ` +
    `L ${w} ${h - rr} ` +
    `C ${w} ${h - rr + k} ${w - rr + k} ${h} ${w - rr} ${h} ` +
    `L ${rr} ${h} ` +
    `C ${rr - k} ${h} 0 ${h - rr + k} 0 ${h - rr} ` +
    `L 0 ${rr} ` +
    `C 0 ${rr - k} ${rr - k} 0 ${rr} 0 Z`
  );
}

// ── Binding resolution ───────────────────────────────────────────────────────

function formatFieldValue(meta, value) {
  if (value == null) return "";
  switch (meta.type) {
    case "toggle":
      return value === true ? "Yes" : value === false ? "No" : "";
    case "radio":
      return (meta.options ?? []).find((o) => o.id === value)?.label ?? "";
    case "checkbox":
      if (!Array.isArray(value)) return "";
      return value
        .map((id) => (meta.options ?? []).find((o) => o.id === id)?.label)
        .filter(Boolean)
        .join(", ");
    case "severity":
      return SEVERITY_LEVELS.find((l) => l.key === value)?.label ?? String(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

function bindingFieldMeta(binding, ctx) {
  if (typeof binding === "string" && binding.startsWith("wt.")) {
    return ctx.fieldIndex.get(binding.slice(3)) ?? null;
  }
  return null;
}

function wtValue(fId, meta, ctx, scope) {
  if (scope && scope.sectionId === meta.sectionId) return scope.fields?.[fId];
  if (meta.sectionKind === "static") {
    return ctx.staticInstances.get(meta.sectionId)?.fields?.[fId];
  }
  return undefined;
}

function resolvePhotoRefs(binding, ctx, scope) {
  const meta = bindingFieldMeta(binding, ctx);
  if (!meta || meta.type !== "photo") return [];
  const value = wtValue(binding.slice(3), meta, ctx, scope);
  if (!Array.isArray(value)) return [];
  return value.filter((p) => p && typeof p === "object" && p.id && p.cloudUri);
}

function resolveBinding(key, ctx, scope) {
  if (key === "report.generatedDate") {
    return formatDate(new Date().toISOString(), ctx.tzOffsetMin, false);
  }
  if (key === "report.inspectorName") return ctx.inspectorName;
  if (key === "report.orgName") return ctx.orgName;
  if (key === "inspection.scheduledAt") {
    return formatDate(ctx.inspection["scheduled_at"] ?? null, ctx.tzOffsetMin, true);
  }
  if (key.startsWith("inspection.")) {
    const col = camelToSnake(key.slice("inspection.".length));
    const v = ctx.inspection[col];
    return v == null ? "" : String(v);
  }
  if (key.startsWith("wt.")) {
    const fId = key.slice(3);
    const meta = ctx.fieldIndex.get(fId);
    if (!meta) return "";
    return formatFieldValue(meta, wtValue(fId, meta, ctx, scope));
  }
  return "";
}

// ── Rich text (Tiptap JSON → paragraphs of styled runs) ─────────────────────

function tiptapToParagraphs(doc, ctx, scope) {
  const paragraphs = [];
  for (const para of doc?.content ?? []) {
    const runs = [];
    for (const node of para?.content ?? []) {
      if (node.type === "text" && node.text) {
        const marks = node.marks ?? [];
        runs.push({
          text: node.text,
          bold: marks.some((m) => m.type === "bold"),
          italic: marks.some((m) => m.type === "italic"),
          underline: marks.some((m) => m.type === "underline"),
          color: marks.find((m) => m.type === "textStyle")?.attrs?.color ?? null,
        });
      } else if (node.type === "bindingChip") {
        const value = resolveBinding(node.attrs?.key ?? "", ctx, scope);
        if (value) {
          runs.push({ text: value, bold: false, italic: false, underline: false, color: null });
        }
      }
    }
    paragraphs.push(runs);
  }
  return paragraphs;
}

// ── Text measurement / wrapping ──────────────────────────────────────────────

function pickFont(fonts, bold, italic) {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

// Wrap runs into lines for a given px width. Width math in px (font widths
// measured in pt then /PX2PT) so all layout stays in one unit space.
// CRITICAL: measure at the DRAWN size (fontSize px × PX2PT = pt) — measuring
// at the raw px number inflates every word advance by ~33%.
function wrapParagraph(runs, fontSize, maxWidthPx, fonts) {
  const sizePt = fontSize * PX2PT;
  const spaceW = (run) =>
    pickFont(fonts, run.bold, run.italic).widthOfTextAtSize(" ", sizePt) / PX2PT;
  const measure = (run, text) =>
    pickFont(fonts, run.bold, run.italic).widthOfTextAtSize(text, sizePt) / PX2PT;

  const lines = [];
  let current = [];
  let width = 0;

  const pushLine = () => {
    lines.push({ words: current, widthPx: width });
    current = [];
    width = 0;
  };

  for (const run of runs) {
    for (const rawWord of run.text.split(/\s+/)) {
      if (!rawWord) continue;
      let word = rawWord;
      let w = measure(run, word);
      // Hard-break words wider than the frame.
      while (w > maxWidthPx && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measure(run, word.slice(0, cut)) > maxWidthPx) cut--;
        const head = word.slice(0, cut);
        if (width > 0) pushLine();
        current.push({ run, text: head, widthPx: measure(run, head) });
        width = measure(run, head);
        pushLine();
        word = word.slice(cut);
        w = measure(run, word);
      }
      const sep = current.length > 0 ? spaceW(run) : 0;
      if (width + sep + w > maxWidthPx && current.length > 0) pushLine();
      current.push({ run, text: word, widthPx: w });
      width += (current.length > 1 ? sep : 0) + w;
    }
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

// ── Layout items ─────────────────────────────────────────────────────────────

function photoTileMetrics(frame, style) {
  const cols = Math.max(1, Number(style.cols ?? 3));
  const gap = Math.max(0, Number(style.gap ?? 12));
  const captions = style.captions !== false;
  const tileW = (frame.w - gap * (cols - 1)) / cols;
  const capH = captions ? 14 : 0;
  const tileH = tileW * 0.72 + capH;
  return { cols, gap, captions, tileW, tileH, capH };
}

// Build final laid-out items for one band instance (one scope).
function layoutBand(band, ctx, scope, fonts, embeddedById) {
  const designedBandH = (() => {
    let maxY = 0;
    for (const s of band.shapes ?? []) maxY = Math.max(maxY, s.frame.y + s.frame.h);
    for (const e of band.elements ?? []) maxY = Math.max(maxY, e.frame.y + e.frame.h);
    return Math.max(band.minHeightPx ?? 48, maxY + 16);
  })();

  // Pass 1 — resolve content + needed heights.
  const pendings = [];

  for (const el of band.elements ?? []) {
    const style = el.style ?? {};
    if (el.type === "text") {
      const fontSize = Number(style.fontSize ?? 14);
      const paragraphs = tiptapToParagraphs(el.content, ctx, scope).map((runs) =>
        wrapParagraph(runs, fontSize, el.frame.w, fonts),
      );
      const lineCount = paragraphs.reduce((n, ls) => n + ls.length, 0);
      const neededH = Math.max(el.frame.h, lineCount * fontSize * LINE_HEIGHT + 4);
      pendings.push({ el, kind: "textBlock", data: { paragraphs, style }, neededH });
    } else if (el.type === "field") {
      const fontSize = Number(style.fontSize ?? 13);
      const variant = String(style.variant ?? "underline");
      const value = el.binding ? resolveBinding(String(el.binding), ctx, scope) : "";
      const padX = variant === "box" ? 8 : 0;
      const run = {
        text: value,
        bold: !!style.bold,
        italic: false,
        underline: false,
        color: null,
      };
      const lines = value
        ? wrapParagraph([run], fontSize, el.frame.w - padX * 2, fonts)
        : [];
      const padY = variant === "box" ? 4 : 2;
      const neededH = Math.max(
        el.frame.h,
        lines.length * fontSize * LINE_HEIGHT + padY * 2,
      );
      pendings.push({
        el,
        kind: "field",
        data: { lines, style, variant, binding: el.binding ?? null, fontSize },
        neededH,
      });
    } else if (el.type === "divider") {
      pendings.push({ el, kind: "divider", data: { style }, neededH: el.frame.h });
    } else if (el.type === "image") {
      pendings.push({
        el,
        kind: "imageEl",
        data: { asset: el.asset ?? null, style },
        neededH: el.frame.h,
      });
    } else if (el.type === "photoGrid") {
      const refs = resolvePhotoRefs(el.binding, ctx, scope);
      const photos = refs
        .map((r) => embeddedById.get(r.id))
        .filter((p) => !!p);
      const m = photoTileMetrics(el.frame, style);
      const rows = photos.length === 0 ? 0 : Math.ceil(photos.length / m.cols);
      const neededH = rows === 0 ? 0 : rows * m.tileH + (rows - 1) * m.gap;
      pendings.push({ el, kind: "photoRow", data: { photos, m, style }, neededH });
    }
  }

  // Pass 2 — push-down. growth sources sorted by designed bottom; an element
  // shifts by the growth of every source whose designed bottom is at or above
  // its designed top (2px tolerance for hand-aligned designs).
  const sources = pendings
    .filter((p) => p.neededH !== p.el.frame.h)
    .map((p) => ({
      bottom: p.el.frame.y + p.el.frame.h,
      growth: p.neededH - p.el.frame.h,
    }))
    .sort((a, b) => a.bottom - b.bottom);

  const shiftFor = (topY) =>
    sources.reduce((acc, s) => (s.bottom <= topY + 2 ? acc + s.growth : acc), 0);

  const items = [];
  let contentBottom = 0;

  for (const p of pendings) {
    const dy = shiftFor(p.el.frame.y);
    const frame = {
      x: p.el.frame.x,
      y: p.el.frame.y + dy,
      w: p.el.frame.w,
      h: p.neededH,
    };
    if (p.kind === "photoRow") {
      const { photos, m } = p.data;
      for (let r = 0; r * m.cols < photos.length; r++) {
        items.push({
          kind: "photoRow",
          frame: { x: frame.x, y: frame.y + r * (m.tileH + m.gap), w: frame.w, h: m.tileH },
          data: { tiles: photos.slice(r * m.cols, (r + 1) * m.cols), m },
        });
      }
      if (photos.length > 0) contentBottom = Math.max(contentBottom, frame.y + frame.h);
    } else {
      items.push({ kind: p.kind, frame, data: p.data });
      contentBottom = Math.max(contentBottom, frame.y + frame.h);
    }
  }

  const grownBandH = Math.max(
    band.minHeightPx ?? 48,
    contentBottom + 16,
    designedBandH + shiftFor(designedBandH),
  );

  // Shapes last (they render first but are positioned after we know the
  // final band height for the stretch rule).
  const shapeItems = [];
  for (const s of band.shapes ?? []) {
    const stretches = s.frame.h >= 0.9 * designedBandH;
    const dy = stretches ? 0 : shiftFor(s.frame.y);
    shapeItems.push({
      kind: "shape",
      frame: {
        x: s.frame.x,
        y: s.frame.y + dy,
        w: s.frame.w,
        h: stretches ? grownBandH - s.frame.y : s.frame.h,
      },
      data: { shape: s.shape, style: s.style ?? {} },
      noSplitPush: true,
    });
  }

  return { items: [...shapeItems, ...items], heightPx: grownBandH };
}

// ── Photo bytes → embed-ready (sharp downscale + EXIF rotate) ────────────────
// Returns { bytes, isPng }. On any sharp failure, falls back to the originals
// so a quirky image degrades gracefully instead of failing the whole report.
// Markup is NOT composited here — the app burns markup onto a print-ready copy
// of the photo (Skia) and the ref carries `burnedCloudUri`, which we embed
// instead of the clean photo (already flat + upright, so this path is a no-op
// rotate for it).
async function prepImageForEmbed(rawBytes) {
  try {
    const img = sharp(Buffer.from(rawBytes), { failOn: "none" });
    const meta = await img.metadata();
    const within =
      (meta.width ?? Infinity) <= PHOTO_MAX_EDGE &&
      (meta.height ?? Infinity) <= PHOTO_MAX_EDGE;
    // Already small and no orientation to bake in — keep originals (preserves
    // PNG/alpha exactly).
    if (within && !meta.orientation && rawBytes.length < 1_500_000) {
      return { bytes: rawBytes, isPng: rawBytes[0] === 0x89 && rawBytes[1] === 0x50 };
    }
    const out = await img
      .rotate() // bake in EXIF orientation, then strip the tag
      .resize({
        width: PHOTO_MAX_EDGE,
        height: PHOTO_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { bytes: new Uint8Array(out), isPng: false };
  } catch (e) {
    logError("photo_prep_failed", e);
    return { bytes: rawBytes, isPng: rawBytes[0] === 0x89 && rawBytes[1] === 0x50 };
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────
export async function renderInspectionReport({
  inspectionSk,
  userId,
  orgSk,
  tzOffsetMin = 0,
}) {
  // 1. Inspection.
  const { data: inspection, error: inspErr } = await admin
    .from("inspections")
    .select("*")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (inspErr) throw new Error(`inspection lookup: ${inspErr.message}`);
  if (!inspection) throw new ReportError("not_found", "Inspection not found.");

  // 2. Inspector profile + org name.
  const { data: profile } = await admin
    .from("users")
    .select("org_sk, fname, lname")
    .eq("id", userId)
    .maybeSingle();
  const effectiveOrgSk = orgSk ?? profile?.org_sk ?? null;

  let orgName = "";
  if (effectiveOrgSk) {
    const { data: org } = await admin
      .from("organizations")
      .select("org_name")
      .eq("org_sk", effectiveOrgSk)
      .maybeSingle();
    orgName = org?.org_name ?? "";
  }

  // 3. Walkthrough form — frozen schema snapshot + answers.
  const { data: formRow } = await admin
    .from("inspection_forms")
    .select("schema_snapshot, answers")
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  const wtSchema = formRow?.schema_snapshot ?? null;
  const answers = formRow?.answers ?? { sections: {} };

  const fieldIndex = new Map();
  const staticInstances = new Map();
  for (const sec of wtSchema?.sections ?? []) {
    for (const f of sec.fields ?? []) {
      fieldIndex.set(f.id, {
        sectionId: sec.id,
        sectionKind: sec.kind,
        type: f.type,
        label: f.label,
        options: f.config?.options ?? null,
      });
    }
    if (sec.kind === "static") {
      const inst = answers?.sections?.[sec.id]?.instances?.[0];
      if (inst) staticInstances.set(sec.id, { fields: inst.fields ?? {} });
    }
  }

  // 4. Report layout — published is the contract; draft a courtesy; else
  // auto-build straight from the walkthrough.
  const { data: tpl } = await admin
    .from("form_templates")
    .select("draft_schema, published_schema")
    .eq("org_sk", effectiveOrgSk)
    .maybeSingle();
  let schema = tpl?.published_schema ?? tpl?.draft_schema ?? null;
  const isLegacy = (schema?.bands ?? []).some((b) => b?.repeat?.collection);
  let autoBuilt = false;
  if ((!schema?.bands?.length || isLegacy) && wtSchema?.sections?.length) {
    schema = walkthroughToReport(wtSchema);
    autoBuilt = true;
  }
  if (!schema?.bands?.length) {
    throw new ReportError(
      "no_template",
      wtSchema
        ? "No report layout found. Publish your walkthrough form in the Form Builder."
        : "Fill out this inspection's walkthrough first, then generate the report.",
    );
  }
  const usedDraft = !autoBuilt && !tpl?.published_schema;

  // 5. Collect referenced photos (only if the layout shows a photo grid).
  const templateHasPhotoGrid = schema.bands.some(
    (b) => (b.elements ?? []).some((e) => e.type === "photoGrid"),
  );
  const photoRefs = [];
  if (templateHasPhotoGrid) {
    for (const sec of Object.values(answers?.sections ?? {})) {
      for (const inst of sec?.instances ?? []) {
        for (const val of Object.values(inst?.fields ?? {})) {
          if (Array.isArray(val)) {
            for (const p of val) {
              if (p && typeof p === "object" && p.id && p.cloudUri) photoRefs.push(p);
            }
          }
        }
      }
    }
  }

  // 6. PDF setup + photo embedding (downscaled).
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  const embeddedById = new Map();
  let imageBytes = 0;
  let skippedPhotos = 0;
  for (const ref of photoRefs) {
    if (imageBytes > MAX_IMAGE_BYTES) {
      skippedPhotos++;
      continue;
    }
    // Print-ready source: the burned (markup-flattened) copy when it exists,
    // else the clean photo. Exactly one image per photo.
    const src = ref.burnedCloudUri ?? ref.cloudUri;
    try {
      const { data: blob, error: dlErr } = await admin.storage
        .from(PHOTO_BUCKET)
        .download(src);
      if (dlErr || !blob) throw dlErr ?? new Error("empty download");
      const raw = new Uint8Array(await blob.arrayBuffer());
      const { bytes, isPng } = await prepImageForEmbed(raw);
      imageBytes += bytes.length;
      const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      embeddedById.set(ref.id, {
        ref: img,
        w: img.width,
        h: img.height,
        caption: ref.note ?? "",
      });
    } catch (e) {
      skippedPhotos++;
      logError("photo_embed_failed", e, { path: src });
    }
  }

  // 7. Layout every band instance, then place with keep-together pagination.
  const ctx = {
    inspection,
    inspectorName: [profile?.fname, profile?.lname].filter(Boolean).join(" "),
    orgName,
    tzOffsetMin,
    fieldIndex,
    staticInstances,
  };

  const placed = [];
  let cursorY = 0;

  for (const band of schema.bands) {
    const repeatSectionId = band.repeat?.sectionId;
    const scopes =
      band.kind === "repeatable" && repeatSectionId
        ? (answers?.sections?.[repeatSectionId]?.instances ?? []).map((inst) => ({
            sectionId: repeatSectionId,
            fields: inst.fields ?? {},
          }))
        : [null];

    for (const scope of scopes) {
      const { items, heightPx } = layoutBand(band, ctx, scope, fonts, embeddedById);

      const remaining = PAGE_CONTENT_H_PX - (cursorY % PAGE_CONTENT_H_PX);
      if (heightPx <= PAGE_CONTENT_H_PX && heightPx > remaining) {
        cursorY += remaining;
      }
      const bandTop = cursorY;

      let extraShift = 0;
      const ordered = [...items].sort((a, b) => a.frame.y - b.frame.y);
      const shiftedAt = [];
      for (const it of ordered) {
        let y = it.frame.y + extraShift;
        const top = bandTop + y;
        const pageOfTop = Math.floor(top / PAGE_CONTENT_H_PX);
        const pageOfBottom = Math.floor((top + it.frame.h - 1) / PAGE_CONTENT_H_PX);
        if (
          pageOfTop !== pageOfBottom &&
          it.frame.h <= PAGE_CONTENT_H_PX &&
          !it.noSplitPush
        ) {
          const delta = (pageOfTop + 1) * PAGE_CONTENT_H_PX - top;
          extraShift += delta;
          shiftedAt.push({ y: it.frame.y, delta });
          y += delta;
        }
        placed.push({ item: { ...it, frame: { ...it.frame, y } }, absY: bandTop + y });
      }
      const bandFinalH = heightPx + shiftedAt.reduce((acc, s) => acc + s.delta, 0);
      cursorY = bandTop + bandFinalH + BAND_GAP_PX;
    }
  }

  const totalH = Math.max(cursorY - BAND_GAP_PX, 1);
  const pageCount = Math.max(1, Math.ceil(totalH / PAGE_CONTENT_H_PX));
  const pages = Array.from({ length: pageCount }, () =>
    pdf.addPage([PAGE_W_PT, PAGE_H_PT]),
  );

  // 8. Draw.
  const toPt = (px) => px * PX2PT;

  const assetCache = new Map();
  async function getFormAsset(path) {
    if (assetCache.has(path)) return assetCache.get(path);
    let embedded = null;
    try {
      const { data: blob, error: dlErr } = await admin.storage
        .from(ASSETS_BUCKET)
        .download(path);
      if (dlErr || !blob) throw dlErr ?? new Error("empty download");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      embedded = { ref: img, w: img.width, h: img.height };
    } catch (e) {
      logError("asset_embed_failed", e, { path });
    }
    assetCache.set(path, embedded);
    return embedded;
  }

  for (const { item, absY } of placed) {
    const pageIdx = Math.min(pages.length - 1, Math.floor(absY / PAGE_CONTENT_H_PX));
    const page = pages[pageIdx];
    const localY = absY - pageIdx * PAGE_CONTENT_H_PX;
    const maxH = PAGE_CONTENT_H_PX - localY;
    const f = item.frame;
    const hPx = item.noSplitPush ? Math.min(f.h, maxH) : f.h;

    const xPt = toPt(MARGIN_PX + f.x);
    const topPt = toPt(MARGIN_PX + localY);
    const wPt = toPt(f.w);
    const hPt = toPt(hPx);
    const yBottomPt = PAGE_H_PT - topPt - hPt;

    if (item.kind === "shape") {
      const { shape, style } = item.data;
      const opacity = Number(style.opacity ?? 1);
      if (shape === "line") {
        const t = toPt(Number(style.strokeWidth ?? 2));
        page.drawRectangle({
          x: xPt,
          y: PAGE_H_PT - topPt - hPt / 2 - t / 2,
          width: wPt,
          height: t,
          color: hexToRgb(style.stroke, "#111827"),
          opacity,
        });
      } else if (shape === "ellipse") {
        page.drawEllipse({
          x: xPt + wPt / 2,
          y: yBottomPt + hPt / 2,
          xScale: wPt / 2,
          yScale: hPt / 2,
          color:
            style.fill && style.fill !== "transparent" ? hexToRgb(style.fill) : undefined,
          borderColor:
            style.stroke && style.stroke !== "transparent" ? hexToRgb(style.stroke) : undefined,
          borderWidth: toPt(Number(style.strokeWidth ?? 1)),
          opacity,
        });
      } else {
        page.drawSvgPath(roundedRectPath(wPt, hPt, toPt(Number(style.radius ?? 0))), {
          x: xPt,
          y: PAGE_H_PT - topPt,
          color:
            style.fill && style.fill !== "transparent" ? hexToRgb(style.fill) : undefined,
          borderColor:
            style.stroke && style.stroke !== "transparent" ? hexToRgb(style.stroke) : undefined,
          borderWidth: toPt(Number(style.strokeWidth ?? 1)),
          opacity,
        });
      }
      continue;
    }

    if (item.kind === "divider") {
      const { style } = item.data;
      const t = toPt(Number(style.thickness ?? 2));
      page.drawRectangle({
        x: xPt,
        y: PAGE_H_PT - topPt - hPt / 2 - t / 2,
        width: wPt,
        height: t,
        color: hexToRgb(style.color, "#E5E7EB"),
      });
      continue;
    }

    if (item.kind === "textBlock" || item.kind === "field") {
      const style = item.data.style ?? {};
      const fontSize = Number(style.fontSize ?? (item.kind === "field" ? 13 : 14));
      const lineHPx = fontSize * LINE_HEIGHT;
      const align = String(style.align ?? "left");
      const baseColor = String(style.color ?? "#111827");
      const variant = item.kind === "field" ? item.data.variant : null;
      const padX = variant === "box" ? 8 : 0;
      const padY = variant === "box" ? 4 : 1;

      if (variant === "box") {
        page.drawSvgPath(roundedRectPath(wPt, hPt, toPt(6)), {
          x: xPt,
          y: PAGE_H_PT - topPt,
          color: hexToRgb("#F9FAFB"),
          borderColor: hexToRgb("#E5E7EB"),
          borderWidth: toPt(1),
        });
      }
      if (variant === "underline") {
        page.drawRectangle({
          x: xPt,
          y: PAGE_H_PT - topPt - hPt,
          width: wPt,
          height: toPt(1.2),
          color: hexToRgb("#9CA3AF"),
        });
      }

      const lineGroups =
        item.kind === "textBlock" ? item.data.paragraphs : [item.data.lines];

      let fieldColor = baseColor;
      if (
        item.kind === "field" &&
        bindingFieldMeta(item.data.binding, ctx)?.type === "severity" &&
        (baseColor === "#111827" || !style.color)
      ) {
        const firstText =
          item.data.lines?.[0]?.words?.map((w) => w.text).join(" ") ?? "";
        fieldColor = severityColor(firstText) ?? baseColor;
      }

      const ASC = 0.718;
      const DESC = 0.207;
      const lineBaselinePx = (lineHPx - (ASC + DESC) * fontSize) / 2 + ASC * fontSize;
      const totalLines = lineGroups.reduce((n, ls) => n + ls.length, 0);
      let firstBasePx;
      if (variant === "underline" && totalLines === 1) {
        firstBasePx = hPx - (DESC * fontSize + 3);
      } else if (variant === "box" && totalLines === 1) {
        firstBasePx = (hPx + ASC * fontSize) / 2;
      } else {
        firstBasePx = padY + lineBaselinePx;
      }

      let lineIdx = 0;
      for (const lines of lineGroups) {
        for (const line of lines) {
          const lineWPt = toPt(line.widthPx);
          let cursorXPt =
            align === "center"
              ? xPt + (wPt - lineWPt) / 2
              : align === "right"
                ? xPt + wPt - toPt(padX) - lineWPt
                : xPt + toPt(padX);
          const baselinePt = PAGE_H_PT - topPt - toPt(firstBasePx + lineIdx * lineHPx);

          for (let wi = 0; wi < line.words.length; wi++) {
            const word = line.words[wi];
            const font = pickFont(fonts, word.run.bold, word.run.italic);
            const sizePt = fontSize * PX2PT;
            const color = hexToRgb(
              word.run.color ?? (item.kind === "field" ? fieldColor : baseColor),
            );
            page.drawText(word.text, { x: cursorXPt, y: baselinePt, size: sizePt, font, color });
            const wordWPt = toPt(word.widthPx);
            if (word.run.underline) {
              page.drawRectangle({
                x: cursorXPt,
                y: baselinePt - 1.5,
                width: wordWPt,
                height: 0.7,
                color,
              });
            }
            cursorXPt += wordWPt;
            if (wi < line.words.length - 1) {
              cursorXPt += font.widthOfTextAtSize(" ", sizePt);
            }
          }
          lineIdx++;
        }
      }
      continue;
    }

    if (item.kind === "imageEl") {
      const path = item.data.asset?.path;
      if (!path || path.startsWith("data:")) continue;
      const asset = await getFormAsset(path);
      if (!asset) continue;
      const scale = Math.min(wPt / asset.w, hPt / asset.h);
      const drawW = asset.w * scale;
      const drawH = asset.h * scale;
      page.drawImage(asset.ref, {
        x: xPt + (wPt - drawW) / 2,
        y: yBottomPt + (hPt - drawH) / 2,
        width: drawW,
        height: drawH,
        opacity: Number(item.data.style?.opacity ?? 1),
      });
      continue;
    }

    if (item.kind === "photoRow") {
      const { tiles, m } = item.data;
      const tileWPt = toPt(m.tileW);
      const capHPt = toPt(m.capH);
      const imgHPt = hPt - capHPt;
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const tileXPt = xPt + i * toPt(m.tileW + m.gap);
        page.drawSvgPath(roundedRectPath(tileWPt, hPt, toPt(8)), {
          x: tileXPt,
          y: PAGE_H_PT - topPt,
          color: hexToRgb("#F3F4F6"),
        });
        const scale = Math.min((tileWPt - 4) / tile.w, (imgHPt - 4) / tile.h);
        const drawW = tile.w * scale;
        const drawH = tile.h * scale;
        page.drawImage(tile.ref, {
          x: tileXPt + (tileWPt - drawW) / 2,
          y: PAGE_H_PT - topPt - 2 - (imgHPt - 4 - drawH) / 2 - drawH,
          width: drawW,
          height: drawH,
        });
        if (m.captions && tile.caption) {
          const capSize = 7.5;
          let cap = tile.caption;
          while (
            cap.length > 1 &&
            fonts.regular.widthOfTextAtSize(cap + "…", capSize) > tileWPt - 8
          ) {
            cap = cap.slice(0, -1);
          }
          if (cap !== tile.caption) cap += "…";
          const capW = fonts.regular.widthOfTextAtSize(cap, capSize);
          page.drawText(cap, {
            x: tileXPt + (tileWPt - capW) / 2,
            y: PAGE_H_PT - topPt - hPt + 4,
            size: capSize,
            font: fonts.regular,
            color: hexToRgb("#6B7280"),
          });
        }
      }
    }
  }

  const bytes = await pdf.save();
  return { bytes, pageCount, skippedPhotos, usedDraft, autoBuilt };
}
