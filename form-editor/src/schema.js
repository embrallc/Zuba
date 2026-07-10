// Document model for form templates.
//
// A template is a vertical stack of BANDS (sections). Bands are either
// "static" (render once) or "repeatable" (stamped out per item of a bound
// collection — v1: walkthrough sections). Inside a band, content is freeform:
//   - shapes[]   — background layer, always rendered BEHIND elements
//   - elements[] — text / bound fields / dividers / photo grids
// Frames are {x, y, w, h} in CSS px at 96dpi against a fixed band width, so
// the generator can lay out deterministically for print.

export const PAGE = {
  size: "letter",
  widthPx: 816, // 8.5in * 96
  heightPx: 1056, // 11in * 96
  marginPx: 48,
};
export const BAND_W = PAGE.widthPx - PAGE.marginPx * 2; // 720
export const PAGE_CONTENT_H = PAGE.heightPx - PAGE.marginPx * 2; // 960
export const GRID = 4;

const id = () => crypto.randomUUID();

export function makeBand(kind = "static", name) {
  return {
    id: id(),
    kind, // "static" | "repeatable"
    name: name ?? (kind === "repeatable" ? "Repeating Section" : "Section"),
    repeat: kind === "repeatable" ? { collection: "sections" } : null,
    minHeightPx: 140,
    shapes: [],
    elements: [],
    // Editor-only grouping metadata. Members are element/shape/group ids in this
    // same band (nestable). Groups have NO frame — bbox is derived from members.
    // The PDF worker ignores this field entirely; leaves keep absolute frames.
    groups: [],
  };
}

// A group is pure metadata: a named set of member ids (elements, shapes, or
// other groups in the same band). Selecting/moving/aligning operate on the
// top-level group; children keep their absolute frames.
export function makeGroup(memberIds = []) {
  return { id: id(), type: "group", memberIds: [...memberIds] };
}

export function makeShape(shape, frame = {}) {
  const defaults =
    shape === "line"
      ? { x: 0, y: 24, w: 240, h: 12 }
      : shape === "ellipse"
        ? { x: 16, y: 16, w: 120, h: 120 }
        : { x: 16, y: 16, w: 200, h: 120 };
  return {
    id: id(),
    shape, // "rect" | "ellipse" | "line"
    frame: { ...defaults, ...frame },
    style: {
      fill: shape === "line" ? "transparent" : "#EEF0FF",
      stroke: shape === "line" ? "#111827" : "transparent",
      strokeWidth: shape === "line" ? 2 : 1,
      radius: 12,
      opacity: 1,
    },
  };
}

// Tiptap doc helper for new text elements.
function textDoc(text, marks = []) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text, marks }] : [],
      },
    ],
  };
}

export function makeElement(type, frame = {}, extra = {}) {
  const base = { id: id(), type };
  switch (type) {
    case "text":
      return {
        ...base,
        frame: { x: 16, y: 16, w: 260, h: 36, ...frame },
        content: extra.content ?? textDoc(extra.text ?? "Text"),
        style: { fontSize: 14, color: "#111827", align: "left", ...extra.style },
      };
    case "field":
      return {
        ...base,
        frame: { x: 16, y: 16, w: 220, h: 26, ...frame },
        binding: extra.binding ?? null,
        label: extra.label ?? "Field",
        style: {
          fontSize: 13,
          color: "#111827",
          align: "left",
          bold: false,
          variant: "underline", // "underline" | "box" | "plain"
          ...extra.style,
        },
      };
    case "divider":
      return {
        ...base,
        frame: { x: 0, y: 16, w: BAND_W, h: 12, ...frame },
        style: { color: "#E5E7EB", thickness: 2, ...extra.style },
      };
    case "photoGrid":
      return {
        ...base,
        frame: { x: 0, y: 16, w: BAND_W, h: 200, ...frame },
        style: { cols: 3, gap: 12, captions: true, radius: 10, ...extra.style },
      };
    case "image":
      // Fixed-size picture (logo, badge, signature). `asset` references an
      // org-scoped upload in the form-assets bucket — never inlined into the
      // template JSON.
      return {
        ...base,
        frame: { x: 16, y: 16, w: 220, h: 110, ...frame },
        asset: extra.asset ?? null, // { path, w, h }
        style: { opacity: 1, ...extra.style },
      };
    default:
      throw new Error(`Unknown element type: ${type}`);
  }
}

export function cloneWithNewIds(node) {
  const copy = structuredClone(node);
  // First pass: give every object with an `id` a fresh id, recording old→new so
  // we can fix up id *references* afterward.
  const idMap = new Map();
  const walk = (n) => {
    if (n && typeof n === "object") {
      if (typeof n.id === "string") {
        const nid = id();
        idMap.set(n.id, nid);
        n.id = nid;
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    }
  };
  walk(copy);
  // Second pass: remap id-reference arrays (group memberIds) to the cloned ids,
  // so duplicating a band/group doesn't leave members pointing at the originals.
  const remap = (n) => {
    if (n && typeof n === "object") {
      if (Array.isArray(n.memberIds)) {
        n.memberIds = n.memberIds.map((m) => idMap.get(m) ?? m);
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(remap);
        else remap(v);
      }
    }
  };
  remap(copy);
  return copy;
}

// Seeded on first open so owners learn the model from a working example
// instead of a blank page.
export function starterTemplate() {
  const header = makeBand("static", "Report Header");
  header.minHeightPx = 128;
  header.shapes.push(
    makeShape("rect", { x: 0, y: 0, w: BAND_W, h: 104 }),
  );
  header.shapes[0].style.fill = "#5C5CE8";
  header.shapes[0].style.radius = 14;
  header.elements.push(
    makeElement(
      "text",
      { x: 24, y: 22, w: 420, h: 38 },
      {
        content: textDoc("Inspection Report", [{ type: "bold" }]),
        style: { fontSize: 24, color: "#FFFFFF" },
      },
    ),
    makeElement(
      "field",
      { x: 24, y: 64, w: 300, h: 22 },
      {
        binding: "report.orgName",
        label: "Company Name",
        style: { variant: "plain", color: "#E4E6FF", fontSize: 13 },
      },
    ),
    makeElement(
      "field",
      { x: 512, y: 64, w: 184, h: 22 },
      {
        binding: "report.generatedDate",
        label: "Report Date",
        style: { variant: "plain", color: "#E4E6FF", fontSize: 13, align: "right" },
      },
    ),
  );

  const client = makeBand("static", "Client & Property");
  client.minHeightPx = 124;
  client.elements.push(
    makeElement(
      "text",
      { x: 0, y: 4, w: 160, h: 20 },
      { content: textDoc("CLIENT", [{ type: "bold" }]), style: { fontSize: 11, color: "#6B7280" } },
    ),
    makeElement("field", { x: 0, y: 28, w: 330, h: 26 }, { binding: "inspection.fullName", label: "Customer Name", style: { fontSize: 14 } }),
    makeElement("field", { x: 0, y: 66, w: 158, h: 24 }, { binding: "inspection.phone", label: "Customer Phone", style: { fontSize: 12 } }),
    makeElement("field", { x: 176, y: 66, w: 154, h: 24 }, { binding: "inspection.email", label: "Customer Email", style: { fontSize: 12 } }),
    makeElement(
      "text",
      { x: 380, y: 4, w: 160, h: 20 },
      { content: textDoc("PROPERTY", [{ type: "bold" }]), style: { fontSize: 11, color: "#6B7280" } },
    ),
    makeElement("field", { x: 380, y: 28, w: 340, h: 26 }, { binding: "inspection.addressLine1", label: "Address Line 1", style: { fontSize: 14 } }),
    makeElement("field", { x: 380, y: 66, w: 150, h: 24 }, { binding: "inspection.city", label: "City", style: { fontSize: 12 } }),
    makeElement("field", { x: 542, y: 66, w: 60, h: 24 }, { binding: "inspection.state", label: "State", style: { fontSize: 12 } }),
    makeElement("field", { x: 614, y: 66, w: 106, h: 24 }, { binding: "inspection.zipCode", label: "Zip Code", style: { fontSize: 12 } }),
  );

  const walkthrough = makeBand("repeatable", "Walkthrough Section");
  walkthrough.minHeightPx = 348;
  walkthrough.shapes.push(makeShape("rect", { x: 0, y: 0, w: BAND_W, h: 40 }));
  walkthrough.shapes[0].style.fill = "#F3F4F6";
  walkthrough.shapes[0].style.radius = 10;
  walkthrough.elements.push(
    makeElement(
      "field",
      { x: 16, y: 8, w: 380, h: 24 },
      { binding: "section.name", label: "Section Name", style: { variant: "plain", fontSize: 15, bold: true } },
    ),
    makeElement(
      "field",
      { x: 556, y: 8, w: 148, h: 24 },
      { binding: "section.severity", label: "Severity", style: { variant: "box", fontSize: 11, align: "center" } },
    ),
    makeElement(
      "field",
      { x: 0, y: 56, w: BAND_W, h: 68 },
      { binding: "section.notes", label: "Section Notes", style: { variant: "box", fontSize: 12 } },
    ),
    makeElement("photoGrid", { x: 0, y: 140, w: BAND_W, h: 190 }),
  );

  const summary = makeBand("static", "Summary");
  summary.minHeightPx = 132;
  summary.elements.push(
    makeElement(
      "text",
      { x: 0, y: 4, w: 160, h: 20 },
      { content: textDoc("SUMMARY", [{ type: "bold" }]), style: { fontSize: 11, color: "#6B7280" } },
    ),
    makeElement(
      "field",
      { x: 0, y: 28, w: BAND_W, h: 88 },
      { binding: "inspection.summary", label: "Report Summary", style: { variant: "box", fontSize: 12 } },
    ),
  );

  return {
    version: 1,
    page: PAGE,
    bands: [header, client, walkthrough, summary],
  };
}

// Live band height: content can push past minHeight; band grows to fit.
export function bandHeight(band) {
  let maxY = 0;
  for (const s of band.shapes) maxY = Math.max(maxY, s.frame.y + s.frame.h);
  for (const e of band.elements) maxY = Math.max(maxY, e.frame.y + e.frame.h);
  return Math.max(band.minHeightPx, maxY + 16);
}

export const snap = (v, disable) =>
  disable ? Math.round(v) : Math.round(v / GRID) * GRID;

export const clampFrame = (f) => ({
  ...f,
  w: Math.max(16, Math.min(f.w, BAND_W)),
  h: Math.max(10, f.h),
  x: Math.max(0, Math.min(f.x, BAND_W - Math.max(16, Math.min(f.w, BAND_W)))),
  y: Math.max(0, f.y),
});

// ── Grouping helpers ─────────────────────────────────────────────────────────
// All pure + tolerant of legacy bands that predate the `groups` field.

export const bandGroups = (band) => band?.groups ?? [];

// The group that DIRECTLY lists `memberId`, or null.
const directGroupOf = (band, memberId) =>
  bandGroups(band).find((g) => g.memberIds.includes(memberId)) ?? null;

// Is this id referenced by any group (i.e. not a top-level object)?
const isContained = (band, someId) =>
  bandGroups(band).some((g) => g.memberIds.includes(someId));

// Walk up to the highest-level group that transitively contains `memberId`,
// or null if it isn't in any group. Clicking a grouped child resolves here.
export function rootGroupOf(band, memberId) {
  let g = directGroupOf(band, memberId);
  if (!g) return null;
  let parent = directGroupOf(band, g.id);
  while (parent) {
    g = parent;
    parent = directGroupOf(band, g.id);
  }
  return g;
}

// Find any id (element / shape / group) → { kind, node }.
export function findNode(band, someId) {
  const e = (band?.elements ?? []).find((n) => n.id === someId);
  if (e) return { kind: "element", node: e };
  const s = (band?.shapes ?? []).find((n) => n.id === someId);
  if (s) return { kind: "shape", node: s };
  const g = bandGroups(band).find((n) => n.id === someId);
  if (g) return { kind: "group", node: g };
  return null;
}

// Top-level objects in a band (elements/shapes/groups not inside another group),
// as { kind, id } refs. Shapes first, then elements, then groups.
export function topLevelObjects(band) {
  const out = [];
  for (const s of band?.shapes ?? [])
    if (!isContained(band, s.id)) out.push({ kind: "shape", id: s.id });
  for (const e of band?.elements ?? [])
    if (!isContained(band, e.id)) out.push({ kind: "element", id: e.id });
  for (const g of bandGroups(band))
    if (!isContained(band, g.id)) out.push({ kind: "group", id: g.id });
  return out;
}

// All leaf (element/shape) ids under an object id, recursing through groups.
export function objectLeafIds(band, someId) {
  const found = findNode(band, someId);
  if (!found) return [];
  if (found.kind !== "group") return [someId];
  const out = [];
  for (const m of found.node.memberIds) out.push(...objectLeafIds(band, m));
  return out;
}

// All group ids at/under an object id (self + descendant groups).
export function descendantGroupIds(band, someId) {
  const found = findNode(band, someId);
  if (!found || found.kind !== "group") return [];
  const out = [someId];
  for (const m of found.node.memberIds) out.push(...descendantGroupIds(band, m));
  return out;
}

// Bounding box of an object: an element/shape frame, or the union for a group.
export function objectBBox(band, someId) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lid of objectLeafIds(band, someId)) {
    const f = findNode(band, lid)?.node?.frame;
    if (!f) continue;
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.w);
    maxY = Math.max(maxY, f.y + f.h);
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Translate every leaf under an object by (dx,dy) in place (immer draft-safe).
// Keeps coords >= 0; callers bound the delta so a group stays rigid in-bounds.
export function translateLeaves(band, someId, dx, dy) {
  for (const lid of objectLeafIds(band, someId)) {
    const f = findNode(band, lid)?.node?.frame;
    if (!f) continue;
    f.x = Math.max(0, f.x + dx);
    f.y = Math.max(0, f.y + dy);
  }
}

// Drop dangling member refs and dissolve groups left with < 2 members. Call
// after any structural delete so groups never reference removed nodes.
export function pruneGroups(band) {
  if (!band?.groups?.length) return;
  const exists = (someId) =>
    (band.elements ?? []).some((e) => e.id === someId) ||
    (band.shapes ?? []).some((s) => s.id === someId) ||
    band.groups.some((g) => g.id === someId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of band.groups) {
      const kept = g.memberIds.filter(exists);
      if (kept.length !== g.memberIds.length) {
        g.memberIds = kept;
        changed = true;
      }
    }
    const before = band.groups.length;
    band.groups = band.groups.filter((g) => g.memberIds.length >= 2);
    if (band.groups.length !== before) changed = true;
  }
}
