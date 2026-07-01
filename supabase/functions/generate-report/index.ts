// generate-report Edge Function.
//
// Renders a paginated PDF from the org's Form Builder template
// (form_templates.published_schema, draft fallback) + one inspection's data,
// stores it in the private `inspection-reports` bucket, and returns a signed
// URL the app downloads once and caches.
//
// Layout model (mirrors the editor's banded schema):
//   - Template = vertical stack of bands. Static bands render once;
//     repeatable bands render once per walkthrough section (ordered by
//     Position).
//   - Inside a band, frames are absolute px at 96dpi (page 816x1056,
//     margins 48, band width 720). PDF points = px * 0.75 (Letter 612x792).
//   - "Can grow" rules: text/field/photoGrid elements that need more height
//     than designed grow downward; every element whose designed top sits
//     below a grown element's designed bottom shifts down by the growth.
//     Shapes covering >=90% of the designed band height stretch with it.
//   - Pagination: bands keep together when they fit on a page; oversized
//     bands flow across pages with elements pushed (whole) past page
//     boundaries. Photo grids are exploded into row items after growth so
//     each row can break independently.
//
// Deploy: npx supabase functions deploy generate-report
// (JWT verification stays ON — only the app calls this.)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "npm:pdf-lib@1.17.1";
// Keystone shared with the browser editor: turns a walkthrough template into a
// report layout. Used here as the zero-config fallback when an org never opens
// the report designer. SEVERITY_LEVELS gives the canonical severity colors.
import { walkthroughToReport } from "../../../shared/walkthroughToReport.js";
import { SEVERITY_LEVELS } from "../../../shared/walkthroughSchema.js";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[generate-report]";

// ── Geometry (px @96dpi → pt @72dpi) ─────────────────────────────────────────
const PX2PT = 0.75;
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;
const MARGIN_PX = 48;
const BAND_W_PX = 720;
const PAGE_CONTENT_H_PX = 960;
const BAND_GAP_PX = 14;
const LINE_HEIGHT = 1.35;
const PHOTO_BUCKET = "inspection-images";
const REPORT_BUCKET = "inspection-reports";
const ASSETS_BUCKET = "form-assets";
// Stop embedding photos past this budget so a 200-photo inspection can't OOM
// the function; the report renders with a placeholder note instead.
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

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

function logError(
  event: string,
  err: unknown,
  fields: Record<string, unknown> = {},
) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error:
        anyErr instanceof Error
          ? anyErr.message
          : (anyErr?.message ?? String(err)),
    }),
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function hexToRgb(hex: string | undefined, fallback = "#111827") {
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

function formatDate(iso: string | null, tzOffsetMin: number, withTime: boolean) {
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

function severityColor(value: string): string | null {
  const v = (value ?? "").toLowerCase();
  // Canonical scale first (label or key match), then a loose legacy fallback.
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

function roundedRectPath(w: number, h: number, r: number): string {
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
// Keys are namespaced (see shared/formBindings.js). `inspection.*` resolves
// mechanically via camelCase→snake_case so new fields added to the bindings
// config work here with zero generator changes.

type FieldMeta = {
  sectionId: string;
  sectionKind: string;
  type: string; // text|toggle|radio|checkbox|severity|photo|heading
  label: string;
  options: { id: string; label: string }[] | null;
};

// A walkthrough section INSTANCE being stamped (one per repeatable instance).
type SectionScope = {
  sectionId: string;
  fields: Record<string, unknown>;
};

type Ctx = {
  inspection: Record<string, unknown>;
  inspectorName: string;
  orgName: string;
  tzOffsetMin: number;
  fieldIndex: Map<string, FieldMeta>;
  // For wt.* bindings placed in STATIC bands: the single instance of each
  // static walkthrough section, keyed by section id.
  staticInstances: Map<string, { fields: Record<string, unknown> }>;
};

// Render a stored answer value to display text per its field type. Choice
// fields resolve option ids → labels; toggles → Yes/No; severity → its label.
function formatFieldValue(meta: FieldMeta, value: unknown): string {
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
      // deno-lint-ignore no-explicit-any
      return SEVERITY_LEVELS.find((l: any) => l.key === value)?.label ?? String(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

// The walkthrough field a binding points at (wt.<fieldId>), or null.
function bindingFieldMeta(
  binding: string | null | undefined,
  ctx: Ctx,
): FieldMeta | null {
  if (typeof binding === "string" && binding.startsWith("wt.")) {
    return ctx.fieldIndex.get(binding.slice(3)) ?? null;
  }
  return null;
}

// The raw value behind a wt.* binding in the current scope (repeatable
// instance) or its home static section.
function wtValue(fId: string, meta: FieldMeta, ctx: Ctx, scope: SectionScope | null): unknown {
  if (scope && scope.sectionId === meta.sectionId) return scope.fields?.[fId];
  if (meta.sectionKind === "static") {
    return ctx.staticInstances.get(meta.sectionId)?.fields?.[fId];
  }
  return undefined;
}

// PhotoRefs (with a cloud copy) behind a photo-field binding.
// deno-lint-ignore no-explicit-any
function resolvePhotoRefs(binding: string | null | undefined, ctx: Ctx, scope: SectionScope | null): any[] {
  const meta = bindingFieldMeta(binding, ctx);
  if (!meta || meta.type !== "photo") return [];
  const value = wtValue((binding as string).slice(3), meta, ctx, scope);
  if (!Array.isArray(value)) return [];
  // PhotoRefs are stored in the answers JSON with camelCase keys.
  // deno-lint-ignore no-explicit-any
  return value.filter((p: any) => p && typeof p === "object" && p.id && p.cloudUri);
}

function resolveBinding(key: string, ctx: Ctx, scope: SectionScope | null): string {
  if (key === "report.generatedDate") {
    return formatDate(new Date().toISOString(), ctx.tzOffsetMin, false);
  }
  if (key === "report.inspectorName") return ctx.inspectorName;
  if (key === "report.orgName") return ctx.orgName;
  if (key === "inspection.scheduledAt") {
    return formatDate(
      (ctx.inspection["scheduled_at"] as string) ?? null,
      ctx.tzOffsetMin,
      true,
    );
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

type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
};

// deno-lint-ignore no-explicit-any
function tiptapToParagraphs(doc: any, ctx: Ctx, scope: SectionScope | null): Run[][] {
  const paragraphs: Run[][] = [];
  for (const para of doc?.content ?? []) {
    const runs: Run[] = [];
    for (const node of para?.content ?? []) {
      if (node.type === "text" && node.text) {
        const marks = node.marks ?? [];
        runs.push({
          text: node.text,
          // deno-lint-ignore no-explicit-any
          bold: marks.some((m: any) => m.type === "bold"),
          // deno-lint-ignore no-explicit-any
          italic: marks.some((m: any) => m.type === "italic"),
          // deno-lint-ignore no-explicit-any
          underline: marks.some((m: any) => m.type === "underline"),
          color:
            // deno-lint-ignore no-explicit-any
            marks.find((m: any) => m.type === "textStyle")?.attrs?.color ?? null,
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

// deno-lint-ignore no-explicit-any
type Fonts = { regular: any; bold: any; italic: any; boldItalic: any };

function pickFont(fonts: Fonts, bold: boolean, italic: boolean) {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

type Word = { run: Run; text: string; widthPx: number };
type Line = { words: Word[]; widthPx: number };

// Wrap runs into lines for a given px width. Width math in px (font widths
// measured in pt then /PX2PT) so all layout stays in one unit space.
// CRITICAL: measure at the DRAWN size (fontSize px × PX2PT = pt) — measuring
// at the raw px number inflates every word advance by ~33%, which renders as
// huge gaps between words.
function wrapParagraph(runs: Run[], fontSize: number, maxWidthPx: number, fonts: Fonts): Line[] {
  const sizePt = fontSize * PX2PT;
  const spaceW = (run: Run) =>
    pickFont(fonts, run.bold, run.italic).widthOfTextAtSize(" ", sizePt) / PX2PT;
  const measure = (run: Run, text: string) =>
    pickFont(fonts, run.bold, run.italic).widthOfTextAtSize(text, sizePt) / PX2PT;

  const lines: Line[] = [];
  let current: Word[] = [];
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

type Frame = { x: number; y: number; w: number; h: number };
// deno-lint-ignore no-explicit-any
type Item = {
  kind: "shape" | "textBlock" | "field" | "divider" | "photoRow" | "imageEl";
  frame: Frame; // final, band-local px
  // deno-lint-ignore no-explicit-any
  data: any;
  noSplitPush?: boolean; // shapes don't get pushed at page boundaries
};

type EmbeddedPhoto = { ref: unknown; w: number; h: number; caption: string };

function photoTileMetrics(frame: Frame, style: Record<string, unknown>) {
  const cols = Math.max(1, Number(style.cols ?? 3));
  const gap = Math.max(0, Number(style.gap ?? 12));
  const captions = style.captions !== false;
  const tileW = (frame.w - gap * (cols - 1)) / cols;
  const capH = captions ? 14 : 0;
  const tileH = tileW * 0.72 + capH;
  return { cols, gap, captions, tileW, tileH, capH };
}

// Build final laid-out items for one band instance (one scope).
function layoutBand(
  // deno-lint-ignore no-explicit-any
  band: any,
  ctx: Ctx,
  scope: SectionScope | null,
  fonts: Fonts,
  embeddedById: Map<string, EmbeddedPhoto>,
): { items: Item[]; heightPx: number } {
  const designedBandH = (() => {
    let maxY = 0;
    for (const s of band.shapes ?? []) maxY = Math.max(maxY, s.frame.y + s.frame.h);
    for (const e of band.elements ?? []) maxY = Math.max(maxY, e.frame.y + e.frame.h);
    return Math.max(band.minHeightPx ?? 48, maxY + 16);
  })();

  // Pass 1 — resolve content + needed heights.
  type Pending = {
    el: Record<string, unknown> & { frame: Frame; style?: Record<string, unknown> };
    kind: Item["kind"];
    // deno-lint-ignore no-explicit-any
    data: any;
    neededH: number;
  };
  const pendings: Pending[] = [];

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
      const run: Run = {
        text: value,
        bold: !!style.bold,
        italic: false,
        underline: false,
        color: null,
      };
      const lines = value
        ? wrapParagraph([run], fontSize, el.frame.w - padX * 2, fonts)
        : [];
      // Matches the editor's .el-field.v-box 4px padding — larger values make
      // single-line boxes grow past their designed frame.
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
      // Fixed frame, never grows. Asset bytes resolved at draw time.
      pendings.push({
        el,
        kind: "imageEl",
        data: { asset: el.asset ?? null, style },
        neededH: el.frame.h,
      });
    } else if (el.type === "photoGrid") {
      // Resolve the bound photo field's PhotoRefs (current instance or its
      // home static section), then map to already-embedded images by id.
      const refs = resolvePhotoRefs(el.binding, ctx, scope);
      const photos = refs
        .map((r) => embeddedById.get(r.id))
        .filter((p): p is EmbeddedPhoto => !!p);
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

  const shiftFor = (topY: number) =>
    sources.reduce((acc, s) => (s.bottom <= topY + 2 ? acc + s.growth : acc), 0);

  const items: Item[] = [];
  let contentBottom = 0;

  for (const p of pendings) {
    const dy = shiftFor(p.el.frame.y);
    const frame: Frame = {
      x: p.el.frame.x,
      y: p.el.frame.y + dy,
      w: p.el.frame.w,
      h: p.neededH,
    };
    if (p.kind === "photoRow") {
      // Explode the grid into row items AFTER growth so rows can break
      // across pages independently.
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
  const shapeItems: Item[] = [];
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

// ── Main ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      logError("missing_env", null);
      return json({ error: "server_misconfigured" }, 500);
    }

    // 1. Auth. Normal calls carry a user JWT (only the owner may render their
    // inspection). Trusted server-to-server calls (the reconcile/send-report
    // EFs) pass the service-role key as the bearer → internal mode: skip the
    // user lookup and derive the owner from the inspection row itself.
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "missing_token" }, 401);
    const internal = jwt === serviceKey;
    let userId: string | null = null;
    if (!internal) {
      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await anonClient.auth.getUser();
      if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
      userId = userData.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const inspectionSk = body?.inspectionSk;
    const tzOffsetMin = Number.isFinite(body?.tzOffsetMinutes)
      ? Number(body.tzOffsetMinutes)
      : 0;
    if (!inspectionSk || typeof inspectionSk !== "string") {
      return json({ error: "missing_inspection" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // 2. Data — inspection must belong to the caller.
    const { data: inspection, error: inspErr } = await admin
      .from("inspections")
      .select("*")
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();
    if (inspErr || !inspection) return json({ error: "not_found" }, 404);
    if (internal) userId = inspection.user_id;
    else if (inspection.user_id !== userId) return json({ error: "forbidden" }, 403);

    // Retrieval mode: the device's cached copy was purged — hand back a fresh
    // signed URL for the newest stored PDF. No re-render, no photo downloads.
    if (body?.action === "latest") {
      const { data: latest } = await admin
        .from("inspection_reports")
        .select("storage_path, page_count, size_bytes, generated_at")
        .eq("inspection_sk", inspectionSk)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest) return json({ error: "no_report" }, 404);
      const { data: signed, error: signErr } = await admin.storage
        .from(REPORT_BUCKET)
        .createSignedUrl(latest.storage_path, 60 * 60 * 24);
      if (signErr || !signed?.signedUrl) {
        logError("sign_failed", signErr, { storagePath: latest.storage_path });
        return json({ error: "sign_failed" }, 500);
      }
      logInfo("report_restored", { userId, inspectionSk });
      return json({
        signedUrl: signed.signedUrl,
        storagePath: latest.storage_path,
        generatedAt: latest.generated_at,
        pageCount: latest.page_count,
        sizeBytes: latest.size_bytes,
        restored: true,
      });
    }

    const { data: profile } = await admin
      .from("users")
      .select("org_sk, fname, lname")
      .eq("id", userId)
      .maybeSingle();
    const orgSk = profile?.org_sk ?? null;

    let orgName = "";
    if (orgSk) {
      const { data: org } = await admin
        .from("organizations")
        .select("org_name")
        .eq("org_sk", orgSk)
        .maybeSingle();
      orgName = org?.org_name ?? "";
    }

    // 3. Walkthrough form — this inspection's frozen schema snapshot + answers.
    const { data: formRow } = await admin
      .from("inspection_forms")
      .select("schema_snapshot, answers")
      .eq("inspection_sk", inspectionSk)
      .maybeSingle();
    // deno-lint-ignore no-explicit-any
    const wtSchema: any = formRow?.schema_snapshot ?? null;
    // deno-lint-ignore no-explicit-any
    const answers: any = formRow?.answers ?? { sections: {} };

    // Index every walkthrough field, and grab the single instance of each
    // static section (so wt.* bindings in static bands resolve).
    const fieldIndex = new Map<string, FieldMeta>();
    const staticInstances = new Map<string, { fields: Record<string, unknown> }>();
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

    // 4. Report layout — the org's published report is the contract; draft is a
    // courtesy. If there's none (or only a LEGACY one using the old section.*
    // model), auto-build a report straight from the walkthrough so an owner who
    // never opens the report designer still gets a polished PDF.
    const { data: tpl } = await admin
      .from("form_templates")
      .select("draft_schema, published_schema")
      .eq("org_sk", orgSk)
      .maybeSingle();
    // deno-lint-ignore no-explicit-any
    let schema: any = tpl?.published_schema ?? tpl?.draft_schema ?? null;
    // deno-lint-ignore no-explicit-any
    const isLegacy = (schema?.bands ?? []).some((b: any) => b?.repeat?.collection);
    let autoBuilt = false;
    if ((!schema?.bands?.length || isLegacy) && wtSchema?.sections?.length) {
      schema = walkthroughToReport(wtSchema);
      autoBuilt = true;
    }
    if (!schema?.bands?.length) {
      return json(
        {
          error: "no_template",
          message: wtSchema
            ? "No report layout found. Publish your walkthrough form in the Form Builder."
            : "Fill out this inspection's walkthrough first, then generate the report.",
        },
        422,
      );
    }
    const usedDraft = !autoBuilt && !tpl?.published_schema;

    // 5. Collect the photos the answers reference — only if the layout shows a
    // photo grid. PhotoRefs live inside the answers JSON (camelCase keys).
    const templateHasPhotoGrid = schema.bands.some(
      // deno-lint-ignore no-explicit-any
      (b: any) => (b.elements ?? []).some((e: any) => e.type === "photoGrid"),
    );
    // deno-lint-ignore no-explicit-any
    const photoRefs: any[] = [];
    if (templateHasPhotoGrid) {
      for (const sec of Object.values(answers?.sections ?? {})) {
        // deno-lint-ignore no-explicit-any
        for (const inst of (sec as any)?.instances ?? []) {
          for (const val of Object.values(inst?.fields ?? {})) {
            if (Array.isArray(val)) {
              for (const p of val) {
                if (p && typeof p === "object" && p.id && p.cloudUri) {
                  photoRefs.push(p);
                }
              }
            }
          }
        }
      }
    }

    // 5. PDF setup + photo embedding
    const pdf = await PDFDocument.create();
    const fonts: Fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    };

    const embeddedById = new Map<string, EmbeddedPhoto>();
    let imageBytes = 0;
    let skippedPhotos = 0;
    for (const ref of photoRefs) {
      if (imageBytes > MAX_IMAGE_BYTES) {
        skippedPhotos++;
        continue;
      }
      try {
        const { data: blob, error: dlErr } = await admin.storage
          .from(PHOTO_BUCKET)
          .download(ref.cloudUri);
        if (dlErr || !blob) throw dlErr ?? new Error("empty download");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        imageBytes += bytes.length;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        embeddedById.set(ref.id, {
          ref: img,
          w: img.width,
          h: img.height,
          caption: ref.note ?? "",
        });
      } catch (e) {
        skippedPhotos++;
        logError("photo_embed_failed", e, { path: ref.cloudUri });
      }
    }

    // 6. Layout every band instance, then place on a continuous canvas with
    // keep-together pagination.
    const ctx: Ctx = {
      inspection,
      inspectorName: [profile?.fname, profile?.lname].filter(Boolean).join(" "),
      orgName,
      tzOffsetMin,
      fieldIndex,
      staticInstances,
    };

    type Placed = { item: Item; absY: number };
    const placed: Placed[] = [];
    let cursorY = 0;

    for (const band of schema.bands) {
      // Repeatable bands stamp once per filled instance of the walkthrough
      // section they're bound to; static bands render once (scope = null).
      const repeatSectionId = band.repeat?.sectionId;
      const scopes: (SectionScope | null)[] =
        band.kind === "repeatable" && repeatSectionId
          ? (answers?.sections?.[repeatSectionId]?.instances ?? []).map(
              // deno-lint-ignore no-explicit-any
              (inst: any) => ({ sectionId: repeatSectionId, fields: inst.fields ?? {} }),
            )
          : [null];

      for (const scope of scopes) {
        const { items, heightPx } = layoutBand(band, ctx, scope, fonts, embeddedById);

        // Keep-together: if the band fits a page but not the remaining space,
        // start it on the next page.
        const remaining = PAGE_CONTENT_H_PX - (cursorY % PAGE_CONTENT_H_PX);
        if (heightPx <= PAGE_CONTENT_H_PX && heightPx > remaining) {
          cursorY += remaining;
        }
        const bandTop = cursorY;

        // Oversized bands flow: push any item (except shapes) that would
        // cross a page boundary fully onto the next page, shifting everything
        // designed below it along.
        let extraShift = 0;
        const ordered = [...items].sort((a, b) => a.frame.y - b.frame.y);
        const shiftedAt: { y: number; delta: number }[] = [];
        for (const it of ordered) {
          let y = it.frame.y + extraShift;
          // re-apply earlier pushes that started above this item
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
        const bandFinalH =
          heightPx + shiftedAt.reduce((acc, s) => acc + s.delta, 0);
        cursorY = bandTop + bandFinalH + BAND_GAP_PX;
      }
    }

    const totalH = Math.max(cursorY - BAND_GAP_PX, 1);
    const pageCount = Math.max(1, Math.ceil(totalH / PAGE_CONTENT_H_PX));
    const pages = Array.from({ length: pageCount }, () =>
      pdf.addPage([PAGE_W_PT, PAGE_H_PT]),
    );

    // 7. Draw
    const toPt = (px: number) => px * PX2PT;

    // Template image assets (logos etc.) — fetched once per unique path no
    // matter how many bands stamp them out.
    const assetCache = new Map<string, { ref: unknown; w: number; h: number } | null>();
    async function getFormAsset(path: string) {
      if (assetCache.has(path)) return assetCache.get(path);
      let embedded: { ref: unknown; w: number; h: number } | null = null;
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
      const pageIdx = Math.min(
        pages.length - 1,
        Math.floor(absY / PAGE_CONTENT_H_PX),
      );
      const page = pages[pageIdx];
      const localY = absY - pageIdx * PAGE_CONTENT_H_PX;
      // Shapes may overhang the page bottom (they aren't pushed) — clamp.
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
              style.fill && style.fill !== "transparent"
                ? hexToRgb(style.fill)
                : undefined,
            borderColor:
              style.stroke && style.stroke !== "transparent"
                ? hexToRgb(style.stroke)
                : undefined,
            borderWidth: toPt(Number(style.strokeWidth ?? 1)),
            opacity,
          });
        } else {
          page.drawSvgPath(roundedRectPath(wPt, hPt, toPt(Number(style.radius ?? 0))), {
            x: xPt,
            y: PAGE_H_PT - topPt,
            color:
              style.fill && style.fill !== "transparent"
                ? hexToRgb(style.fill)
                : undefined,
            borderColor:
              style.stroke && style.stroke !== "transparent"
                ? hexToRgb(style.stroke)
                : undefined,
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

        const lineGroups: Line[][] =
          item.kind === "textBlock"
            ? item.data.paragraphs
            : [item.data.lines];

        // Severity sugar: auto-color recognized severity values unless the
        // designer picked a non-default color.
        let fieldColor = baseColor;
        if (
          item.kind === "field" &&
          bindingFieldMeta(item.data.binding, ctx)?.type === "severity" &&
          (baseColor === "#111827" || !style.color)
        ) {
          const firstText = item.data.lines?.[0]?.words?.map((w: Word) => w.text).join(" ") ?? "";
          fieldColor = severityColor(firstText) ?? baseColor;
        }

        // Helvetica metrics per 1em: ascent .718, descent .207. The first
        // baseline includes CSS-style half-leading — (lineHeight − ascent −
        // descent)/2 above the glyphs — so text lands where the editor's
        // line boxes put it. Two single-line refinements: underline fields
        // pin the baseline just above their line (form-like), and box fields
        // optically center their cap height in the box.
        const ASC = 0.718;
        const DESC = 0.207;
        const lineBaselinePx =
          (lineHPx - (ASC + DESC) * fontSize) / 2 + ASC * fontSize;
        const totalLines = lineGroups.reduce(
          (n: number, ls: Line[]) => n + ls.length,
          0,
        );
        let firstBasePx: number;
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
            const baselinePt =
              PAGE_H_PT - topPt - toPt(firstBasePx + lineIdx * lineHPx);

            for (let wi = 0; wi < line.words.length; wi++) {
              const word = line.words[wi];
              const font = pickFont(fonts, word.run.bold, word.run.italic);
              const sizePt = fontSize * PX2PT;
              const color = hexToRgb(
                word.run.color ?? (item.kind === "field" ? fieldColor : baseColor),
              );
              page.drawText(word.text, {
                x: cursorXPt,
                y: baselinePt,
                size: sizePt,
                font,
                color,
              });
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
        // data: URLs only exist in local-preview templates; storage paths are
        // the published contract.
        if (!path || path.startsWith("data:")) continue;
        const asset = await getFormAsset(path);
        if (!asset) continue;
        const scale = Math.min(wPt / asset.w, hPt / asset.h);
        const drawW = asset.w * scale;
        const drawH = asset.h * scale;
        // deno-lint-ignore no-explicit-any
        page.drawImage(asset.ref as any, {
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
          const tile: EmbeddedPhoto = tiles[i];
          const tileXPt = xPt + i * toPt(m.tileW + m.gap);
          // Tile background
          page.drawSvgPath(roundedRectPath(tileWPt, hPt, toPt(8)), {
            x: tileXPt,
            y: PAGE_H_PT - topPt,
            color: hexToRgb("#F3F4F6"),
          });
          // Contain-fit image
          const scale = Math.min(
            (tileWPt - 4) / tile.w,
            (imgHPt - 4) / tile.h,
          );
          const drawW = tile.w * scale;
          const drawH = tile.h * scale;
          // deno-lint-ignore no-explicit-any
          page.drawImage(tile.ref as any, {
            x: tileXPt + (tileWPt - drawW) / 2,
            y: PAGE_H_PT - topPt - 2 - (imgHPt - 4 - drawH) / 2 - drawH,
            width: drawW,
            height: drawH,
          });
          // Caption — single line, ellipsized
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

    // 8. Save + upload + record
    const pdfBytes = await pdf.save();
    const storagePath = `${orgSk ?? "no-org"}/${userId}/${inspectionSk}/${Date.now()}.pdf`;
    const { error: upErr } = await admin.storage
      .from(REPORT_BUCKET)
      .upload(storagePath, pdfBytes, { contentType: "application/pdf" });
    if (upErr) {
      logError("report_upload_failed", upErr, { storagePath });
      return json({ error: "upload_failed" }, 500);
    }

    const generatedAt = new Date().toISOString();
    const { error: rowErr } = await admin.from("inspection_reports").insert({
      inspection_sk: inspectionSk,
      org_sk: orgSk,
      user_id: userId,
      storage_path: storagePath,
      page_count: pageCount,
      size_bytes: pdfBytes.length,
      generated_at: generatedAt,
    });
    if (rowErr) logError("report_row_failed", rowErr, { storagePath });

    const { data: signed, error: signErr } = await admin.storage
      .from(REPORT_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24);
    if (signErr || !signed?.signedUrl) {
      logError("sign_failed", signErr, { storagePath });
      return json({ error: "sign_failed" }, 500);
    }

    logInfo("report_generated", {
      userId,
      inspectionSk,
      pageCount,
      sizeBytes: pdfBytes.length,
      photos: photoRefs.length - skippedPhotos,
      skippedPhotos,
      autoBuilt,
      usedDraft,
    });

    return json({
      signedUrl: signed.signedUrl,
      storagePath,
      generatedAt,
      pageCount,
      sizeBytes: pdfBytes.length,
      usedDraft,
      skippedPhotos,
    });
  } catch (e) {
    logError("unhandled", e);
    return json({ error: "internal" }, 500);
  }
});
