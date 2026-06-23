// VENDORED COPY — keep in sync with /shared/walkthroughToReport.js.
// The worker deploys with build context = report-worker/ only, so the repo's
// /shared modules aren't in the Docker image; they're mirrored here verbatim.
// ─────────────────────────────────────────────────────────────────────────────
// Walkthrough → Report. The friendliness keystone.
//
// Turns a walkthrough template (what the inspector fills in) into a complete,
// professional report layout (what the client receives) — with ZERO manual
// field mapping. Used two ways:
//   1. Report editor "Build from my form" button (seeds the canvas).
//   2. generate-report FALLBACK — if an org never opens the report designer,
//      reports still render beautifully straight from their walkthrough.
//
// Pure, dependency-free JS so it runs in the browser editor AND the Deno
// report generator (same file, no drift). The report schema shape it emits
// matches form-editor/src/schema.js: { version, page, bands[] }, where bands
// hold absolute-positioned shapes[] + elements[] in a 720px-wide content box.
//
// Binding namespace it emits:
//   inspection.<field> · report.<meta>   — relational / computed (unchanged)
//   wt.<fieldId>                          — a walkthrough field value
// Repeatable report bands carry repeat:{ sectionId } pointing at a walkthrough
// repeatable section; the generator stamps them once per filled instance.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE = { size: "letter", widthPx: 816, heightPx: 1056, marginPx: 48 };
export const BAND_W = PAGE.widthPx - PAGE.marginPx * 2; // 720
const BRAND = "#5C5CE8";
const INK = "#111827";
const MUTED = "#6B7280";

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── Binding descriptors (palette + label resolution) ─────────────────────────
// Every fillable walkthrough field becomes a bindable token. Headings carry no
// value so they're skipped. Scope mirrors the section kind: "section"-scope
// tokens only resolve inside a repeatable band bound to their section.
export function walkthroughFieldBindings(schema) {
  const out = [];
  for (const sec of schema?.sections ?? []) {
    const scope = sec.kind === "repeatable" ? "section" : "static";
    for (const f of sec.fields ?? []) {
      if (f.type === "heading") continue;
      out.push({
        key: `wt.${f.id}`,
        label: f.label,
        fieldType: f.type, // text|toggle|radio|checkbox|severity|photo
        type: f.type === "photo" ? "image" : "text",
        scope,
        sectionId: sec.id,
        sectionTitle: sec.title,
        sectionKind: sec.kind,
        options: f.config?.options ?? null,
      });
    }
  }
  return out;
}

export function walkthroughBindingByKey(schema, key) {
  if (!key) return null;
  return walkthroughFieldBindings(schema).find((b) => b.key === key) ?? null;
}

export function repeatableSections(schema) {
  return (schema?.sections ?? []).filter((s) => s.kind === "repeatable");
}

// ── Element factories (match the report schema shape) ────────────────────────
function textDoc(text, marks = []) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: text ? [{ type: "text", text, marks }] : [] },
    ],
  };
}

function textEl(x, y, w, h, text, style = {}, bold = false) {
  return {
    id: uid(),
    type: "text",
    frame: { x, y, w, h },
    content: textDoc(text, bold ? [{ type: "bold" }] : []),
    style: { fontSize: 14, color: INK, align: "left", ...style },
  };
}

function fieldEl(x, y, w, h, binding, label, style = {}) {
  return {
    id: uid(),
    type: "field",
    frame: { x, y, w, h },
    binding,
    label,
    style: { fontSize: 13, color: INK, align: "left", bold: false, variant: "plain", ...style },
  };
}

function photoGridEl(x, y, w, h, binding, style = {}) {
  return {
    id: uid(),
    type: "photoGrid",
    frame: { x, y, w, h },
    binding,
    style: { cols: 3, gap: 12, captions: true, radius: 10, ...style },
  };
}

function rectShape(x, y, w, h, fill, radius = 12) {
  return {
    id: uid(),
    shape: "rect",
    frame: { x, y, w, h },
    style: { fill, stroke: "transparent", strokeWidth: 1, radius, opacity: 1 },
  };
}

function band(kind, name, minHeightPx, repeat = null) {
  return { id: uid(), kind, name, repeat, minHeightPx, shapes: [], elements: [] };
}

const OVERLINE = { fontSize: 10, color: MUTED, align: "left" };

// Stack one section's fields vertically into a band, flowing y downward.
// Returns the y cursor after the last field.
function layoutFields(b, fields, startY) {
  let y = startY;
  for (const f of fields ?? []) {
    if (f.type === "heading") {
      b.elements.push(textEl(0, y, BAND_W, 22, f.label, { fontSize: 13, color: INK }, true));
      y += 30;
      continue;
    }
    if (f.type === "photo") {
      b.elements.push(textEl(0, y, BAND_W, 14, (f.label || "Photos").toUpperCase(), OVERLINE, true));
      y += 17;
      b.elements.push(photoGridEl(0, y, BAND_W, 190, `wt.${f.id}`));
      y += 202;
      continue;
    }
    // label + value
    b.elements.push(textEl(0, y, BAND_W, 14, (f.label || "").toUpperCase(), OVERLINE, true));
    y += 17;
    const multiline = f.type === "text" && (f.config?.variant ?? "line") === "multiline";
    const h = multiline ? 52 : 24;
    const variant = multiline || f.type === "severity" ? "box" : "plain";
    const fontSize = f.type === "severity" ? 12 : 14;
    const align = f.type === "severity" ? "center" : "left";
    b.elements.push(
      fieldEl(0, y, multiline ? BAND_W : Math.min(BAND_W, 520), h, `wt.${f.id}`, f.label, {
        variant,
        fontSize,
        align,
      }),
    );
    y += h + 14;
  }
  return y;
}

// ── The build ────────────────────────────────────────────────────────────────
export function walkthroughToReport(schema) {
  const bands = [];

  // Header — brand bar with company name + report date.
  const header = band("static", "Report Header", 120);
  header.shapes.push(rectShape(0, 0, BAND_W, 92, BRAND, 14));
  header.elements.push(
    textEl(24, 20, 460, 32, "Inspection Report", { fontSize: 22, color: "#FFFFFF" }, true),
    fieldEl(24, 58, 320, 20, "report.orgName", "Company Name", {
      variant: "plain",
      color: "#E4E6FF",
      fontSize: 13,
    }),
    fieldEl(470, 58, 226, 20, "report.generatedDate", "Report Date", {
      variant: "plain",
      color: "#E4E6FF",
      fontSize: 13,
      align: "right",
    }),
  );
  bands.push(header);

  // Client & Property.
  const cp = band("static", "Client & Property", 120);
  cp.elements.push(
    textEl(0, 2, 200, 16, "CLIENT", OVERLINE, true),
    fieldEl(0, 24, 330, 24, "inspection.fullName", "Customer Name", { fontSize: 15 }),
    fieldEl(0, 60, 158, 22, "inspection.phone", "Customer Phone", { fontSize: 12 }),
    fieldEl(176, 60, 154, 22, "inspection.email", "Customer Email", { fontSize: 12 }),
    textEl(380, 2, 200, 16, "PROPERTY", OVERLINE, true),
    fieldEl(380, 24, 340, 24, "inspection.addressLine1", "Address Line 1", { fontSize: 15 }),
    fieldEl(380, 60, 150, 22, "inspection.city", "City", { fontSize: 12 }),
    fieldEl(542, 60, 60, 22, "inspection.state", "State", { fontSize: 12 }),
    fieldEl(614, 60, 106, 22, "inspection.zipCode", "Zip Code", { fontSize: 12 }),
  );
  bands.push(cp);

  // One band per walkthrough section, in order.
  for (const sec of schema?.sections ?? []) {
    const repeatable = sec.kind === "repeatable";
    const b = band(
      repeatable ? "repeatable" : "static",
      sec.title || (repeatable ? "Section" : "Section"),
      80,
      repeatable ? { sectionId: sec.id } : null,
    );
    // Section title + a brand underline.
    b.elements.push(textEl(0, 4, BAND_W, 22, sec.title || "Section", { fontSize: 15, color: INK }, true));
    b.shapes.push(rectShape(0, 30, BAND_W, 2, "#E5E7EB", 1));
    const endY = layoutFields(b, sec.fields, 42);
    b.minHeightPx = Math.max(80, endY + 8);
    bands.push(b);
  }

  return { version: 1, page: PAGE, bands };
}
