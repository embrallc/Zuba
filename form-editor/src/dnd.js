// Native HTML5 drag-and-drop wiring. Custom MIME types keep our payloads from
// colliding with text drops, and native DnD is what lets binding chips drop
// straight into Tiptap editors at the caret position.
export const MIME = {
  element: "application/x-zanbi-element",
  shape: "application/x-zanbi-shape",
  band: "application/x-zanbi-band",
  binding: "application/x-zanbi-binding",
};

export function setPayload(e, mime, payload) {
  e.dataTransfer.setData(mime, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copy";
}

export function getPayload(e, mime) {
  const raw = e.dataTransfer.getData(mime);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function hasType(e, mime) {
  return Array.from(e.dataTransfer?.types ?? []).includes(mime);
}

// Pointer position → band-local coordinates, compensating for canvas zoom.
export function dropPoint(e, hostEl, zoom) {
  const rect = hostEl.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / zoom,
    y: (e.clientY - rect.top) / zoom,
  };
}

// Smart guides: snap a moving frame's edges/centers to siblings within
// `threshold` px and report the matched guide lines for rendering.
export function snapWithGuides(frame, siblings, bandW, threshold = 5) {
  const guides = [];
  let { x, y } = frame;
  const movingX = [
    { v: x, apply: (g) => g },
    { v: x + frame.w / 2, apply: (g) => g - frame.w / 2 },
    { v: x + frame.w, apply: (g) => g - frame.w },
  ];
  const movingY = [
    { v: y, apply: (g) => g },
    { v: y + frame.h / 2, apply: (g) => g - frame.h / 2 },
    { v: y + frame.h, apply: (g) => g - frame.h },
  ];
  const targetsX = [0, bandW / 2, bandW];
  const targetsY = [];
  for (const s of siblings) {
    targetsX.push(s.frame.x, s.frame.x + s.frame.w / 2, s.frame.x + s.frame.w);
    targetsY.push(s.frame.y, s.frame.y + s.frame.h / 2, s.frame.y + s.frame.h);
  }
  let bestX = null;
  for (const m of movingX) {
    for (const t of targetsX) {
      const d = Math.abs(m.v - t);
      if (d <= threshold && (bestX === null || d < bestX.d)) {
        bestX = { d, x: m.apply(t), line: t };
      }
    }
  }
  let bestY = null;
  for (const m of movingY) {
    for (const t of targetsY) {
      const d = Math.abs(m.v - t);
      if (d <= threshold && (bestY === null || d < bestY.d)) {
        bestY = { d, y: m.apply(t), line: t };
      }
    }
  }
  if (bestX) {
    x = bestX.x;
    guides.push({ axis: "x", pos: bestX.line });
  }
  if (bestY) {
    y = bestY.y;
    guides.push({ axis: "y", pos: bestY.line });
  }
  return { x, y, guides };
}
