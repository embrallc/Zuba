import { useEditorStore } from "../store";
import { BAND_W, GRID, snap } from "../schema";
import { snapWithGuides } from "../dnd";

// Pointer-based move/resize for elements and shapes. One gesture = one undo
// step: beginHistory() fires at pointerdown, every pointermove is transient.
// All deltas are divided by zoom because the canvas is CSS-scaled.
export function useDragNode({ kind, bandId, id }) {
  const onPointerDown = (e, mode = "move") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const store = useEditorStore.getState();
    const sel = { kind, bandId, id };
    store.select(sel);
    store.beginHistory();

    const zoom = store.zoom;
    const band = store.schema.bands.find((b) => b.id === bandId);
    const list = kind === "shape" ? band.shapes : band.elements;
    const start = { ...list.find((n) => n.id === id).frame };
    const px = e.clientX;
    const py = e.clientY;

    const onMove = (ev) => {
      const dx = (ev.clientX - px) / zoom;
      const dy = (ev.clientY - py) / zoom;
      const st = useEditorStore.getState();
      let frame = { ...start };

      if (mode === "move") {
        frame.x = start.x + dx;
        frame.y = start.y + dy;
        const b = st.schema.bands.find((bb) => bb.id === bandId);
        const siblings = [...b.shapes, ...b.elements].filter((n) => n.id !== id);
        if (ev.altKey) {
          st.setGuides([]);
        } else {
          const res = snapWithGuides(frame, siblings, BAND_W);
          frame.x = res.guides.some((g) => g.axis === "x") ? res.x : snap(frame.x);
          frame.y = res.guides.some((g) => g.axis === "y") ? res.y : snap(frame.y);
          st.setGuides(res.guides.map((g) => ({ ...g, bandId })));
        }
      } else {
        if (mode.includes("e")) frame.w = snap(start.w + dx, ev.altKey);
        if (mode.includes("s")) frame.h = snap(start.h + dy, ev.altKey);
        if (mode.includes("w")) {
          frame.w = snap(start.w - dx, ev.altKey);
          frame.x = start.x + (start.w - frame.w);
        }
        if (mode.includes("n")) {
          frame.h = snap(start.h - dy, ev.altKey);
          frame.y = start.y + (start.h - frame.h);
        }
      }
      st.updateNode(sel, { frame }, { transient: true });
    };

    const onUp = () => {
      useEditorStore.getState().setGuides([]);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { onPointerDown };
}

// Drag the bottom edge of a band to set its minimum height.
export function useBandResize(bandId, currentHeight) {
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const store = useEditorStore.getState();
    store.beginHistory();
    const zoom = store.zoom;
    const startY = e.clientY;
    const startH = currentHeight;

    const onMove = (ev) => {
      const dy = (ev.clientY - startY) / zoom;
      const next = Math.max(48, Math.round((startH + dy) / GRID) * GRID);
      useEditorStore.setState((state) => ({
        schema: {
          ...state.schema,
          bands: state.schema.bands.map((b) =>
            b.id === bandId ? { ...b, minHeightPx: next } : b,
          ),
        },
        dirty: true,
      }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return { onPointerDown };
}

export const RESIZE_HANDLES = [
  { mode: "nw", style: { left: -5, top: -5, cursor: "nwse-resize" } },
  { mode: "n", style: { left: "calc(50% - 4.5px)", top: -5, cursor: "ns-resize" } },
  { mode: "ne", style: { right: -5, top: -5, cursor: "nesw-resize" } },
  { mode: "e", style: { right: -5, top: "calc(50% - 4.5px)", cursor: "ew-resize" } },
  { mode: "se", style: { right: -5, bottom: -5, cursor: "nwse-resize" } },
  { mode: "s", style: { left: "calc(50% - 4.5px)", bottom: -5, cursor: "ns-resize" } },
  { mode: "sw", style: { left: -5, bottom: -5, cursor: "nesw-resize" } },
  { mode: "w", style: { left: -5, top: "calc(50% - 4.5px)", cursor: "ew-resize" } },
];
