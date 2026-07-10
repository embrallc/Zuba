import { produce } from "immer";
import { useEditorStore } from "../store";
import {
  BAND_W,
  GRID,
  findNode,
  objectLeafIds,
  rootGroupOf,
  snap,
} from "../schema";
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

    // Ctrl/Cmd-click toggles the multi-selection instead of dragging.
    if (mode === "move" && (e.ctrlKey || e.metaKey)) {
      store.toggleSelect({ bandId, id });
      return;
    }

    const band = store.schema.bands.find((b) => b.id === bandId);
    if (!band) return;
    const zoom = store.zoom;
    const px = e.clientX;
    const py = e.clientY;

    // ── Resize: single element/shape only (handles never render for a group or
    // a multi-selection), so this path is unchanged from before grouping.
    if (mode !== "move") {
      const sel = { kind, bandId, id };
      store.select(sel);
      store.beginHistory();
      const list = kind === "shape" ? band.shapes : band.elements;
      const start = { ...list.find((n) => n.id === id).frame };
      const onMove = (ev) => {
        const dx = (ev.clientX - px) / zoom;
        const dy = (ev.clientY - py) / zoom;
        const frame = { ...start };
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
        useEditorStore.getState().updateNode(sel, { frame }, { transient: true });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    // ── Move. Resolve the clicked node to its top-level object (root group or
    // itself), then decide whether we drag the whole multi-set or just this one.
    const rootGroup = rootGroupOf(band, id);
    const topId = rootGroup ? rootGroup.id : id;

    let dragIds;
    if (
      store.selectedIds.length >= 2 &&
      store.selectionBandId === bandId &&
      store.selectedIds.includes(topId)
    ) {
      dragIds = [...store.selectedIds]; // drag the entire multi-selection
    } else {
      store.selectResolved({ bandId, id });
      dragIds = [topId];
    }
    store.beginHistory();

    // A bare single node (no group, not multi): keep the original move with
    // smart alignment guides.
    if (dragIds.length === 1 && !rootGroup) {
      const sel = { kind, bandId, id };
      const list = kind === "shape" ? band.shapes : band.elements;
      const start = { ...list.find((n) => n.id === id).frame };
      const onMove = (ev) => {
        const dx = (ev.clientX - px) / zoom;
        const dy = (ev.clientY - py) / zoom;
        const st = useEditorStore.getState();
        const frame = { ...start, x: start.x + dx, y: start.y + dy };
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
        st.updateNode(sel, { frame }, { transient: true });
      };
      const onUp = () => {
        useEditorStore.getState().setGuides([]);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    // Group / multi: rigid-translate every leaf from its start frame (grid-snap
    // the delta; no smart guides in v1).
    const bandNow = useEditorStore.getState().schema.bands.find((b) => b.id === bandId);
    const leafIds = [...new Set(dragIds.flatMap((oid) => objectLeafIds(bandNow, oid)))];
    const starts = new Map();
    for (const lid of leafIds) {
      const f = findNode(bandNow, lid)?.node?.frame;
      if (f) starts.set(lid, { x: f.x, y: f.y });
    }
    const onMove = (ev) => {
      let dx = (ev.clientX - px) / zoom;
      let dy = (ev.clientY - py) / zoom;
      if (!ev.altKey) {
        dx = snap(dx);
        dy = snap(dy);
      }
      useEditorStore.setState((state) => ({
        schema: produce(state.schema, (d) => {
          const b = d.bands.find((bb) => bb.id === bandId);
          if (!b) return;
          for (const [lid, s0] of starts) {
            const f = findNode(b, lid)?.node?.frame;
            if (f) {
              f.x = Math.max(0, s0.x + dx);
              f.y = Math.max(0, s0.y + dy);
            }
          }
        }),
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
