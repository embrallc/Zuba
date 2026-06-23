import { produce } from "immer";
import { create } from "zustand";
import { bandHeight, clampFrame, cloneWithNewIds, makeBand } from "./schema";

// History model: snapshot-based undo. Every discrete mutation pushes the
// prior schema onto `past`. Continuous interactions (drag/resize/typing)
// call beginHistory() ONCE at gesture start, then flow through transient
// updates that don't push — so one drag = one undo step.
const HISTORY_LIMIT = 60;

export const useEditorStore = create((set, get) => {
  const pushHistory = (state) => ({
    past: [...state.past.slice(-HISTORY_LIMIT + 1), structuredClone(state.schema)],
    future: [],
  });

  // Discrete mutation: snapshot, then apply.
  const mutate = (fn) =>
    set((state) => ({
      ...pushHistory(state),
      schema: produce(state.schema, fn),
      dirty: true,
    }));

  // Transient mutation: no snapshot (caller ran beginHistory at gesture start).
  const mutateTransient = (fn) =>
    set((state) => ({ schema: produce(state.schema, fn), dirty: true }));

  const findBand = (draft, bandId) => draft.bands.find((b) => b.id === bandId);

  return {
    schema: null,
    name: "Inspection Report",
    // The org's walkthrough template — loaded at boot so the report's binding
    // palette and field labels reflect the real fields the owner built.
    walkthroughSchema: null,
    selected: null, // {kind:"band"|"element"|"shape", bandId, id}
    editingTextId: null,
    zoom: 1,
    guides: [], // smart-guide lines during drag: {axis:"x"|"y", pos, bandId}
    // "local" = no token, persisting to localStorage only
    saveState: "idle", // idle | dirty | saving | saved | error | conflict | local
    dirty: false,
    past: [],
    future: [],

    loadSchema: (schema, name) =>
      set({ schema, ...(name ? { name } : {}), past: [], future: [], dirty: false }),

    // Replace the whole schema as ONE undoable step (e.g. "Build from my
    // walkthrough form"). Unlike loadSchema it keeps history so the prior
    // design can be restored with Undo.
    replaceSchema: (schema) =>
      set((state) => ({
        ...pushHistory(state),
        schema,
        selected: null,
        editingTextId: null,
        dirty: true,
      })),

    setName: (name) => set({ name, dirty: true }),
    setWalkthroughSchema: (walkthroughSchema) => set({ walkthroughSchema }),
    setZoom: (zoom) => set({ zoom }),
    setSaveState: (saveState) => set({ saveState }),
    setGuides: (guides) => set({ guides }),
    markClean: () => set({ dirty: false }),

    select: (selected) => set({ selected, editingTextId: null }),
    deselect: () => set({ selected: null, editingTextId: null }),

    // Entering text-edit is one undo step for the whole editing session.
    startEditText: (bandId, id) =>
      set((state) => ({
        ...pushHistory(state),
        selected: { kind: "element", bandId, id },
        editingTextId: id,
      })),
    stopEditText: () => set({ editingTextId: null }),

    beginHistory: () => set((state) => pushHistory(state)),

    undo: () =>
      set((state) => {
        if (!state.past.length) return state;
        const past = [...state.past];
        const prev = past.pop();
        return {
          past,
          future: [structuredClone(state.schema), ...state.future].slice(0, HISTORY_LIMIT),
          schema: prev,
          selected: null,
          editingTextId: null,
          dirty: true,
        };
      }),

    redo: () =>
      set((state) => {
        if (!state.future.length) return state;
        const [next, ...future] = state.future;
        return {
          past: [...state.past, structuredClone(state.schema)].slice(-HISTORY_LIMIT),
          future,
          schema: next,
          selected: null,
          editingTextId: null,
          dirty: true,
        };
      }),

    // ── Bands ────────────────────────────────────────────────────────────────
    addBand: (kind, index) =>
      mutate((d) => {
        const band = makeBand(kind);
        const i = index ?? d.bands.length;
        d.bands.splice(i, 0, band);
      }),

    updateBand: (bandId, patch) =>
      mutate((d) => {
        const b = findBand(d, bandId);
        if (b) Object.assign(b, patch);
      }),

    moveBand: (bandId, dir) =>
      mutate((d) => {
        const i = d.bands.findIndex((b) => b.id === bandId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.bands.length) return;
        const [b] = d.bands.splice(i, 1);
        d.bands.splice(j, 0, b);
      }),

    duplicateBand: (bandId) =>
      mutate((d) => {
        const i = d.bands.findIndex((b) => b.id === bandId);
        if (i < 0) return;
        d.bands.splice(i + 1, 0, cloneWithNewIds(d.bands[i]));
      }),

    removeBand: (bandId) =>
      mutate((d) => {
        d.bands = d.bands.filter((b) => b.id !== bandId);
      }),

    // ── Elements & shapes ────────────────────────────────────────────────────
    addElement: (bandId, element) => {
      mutate((d) => {
        findBand(d, bandId)?.elements.push(element);
      });
      set({ selected: { kind: "element", bandId, id: element.id } });
    },

    addShape: (bandId, shape) => {
      mutate((d) => {
        findBand(d, bandId)?.shapes.push(shape);
      });
      set({ selected: { kind: "shape", bandId, id: shape.id } });
    },

    updateNode: (sel, patch, { transient = false } = {}) => {
      const apply = (d) => {
        const band = findBand(d, sel.bandId);
        if (!band) return;
        const list = sel.kind === "shape" ? band.shapes : band.elements;
        const node = list.find((n) => n.id === sel.id);
        if (!node) return;
        if (patch.frame) {
          node.frame = clampFrame({ ...node.frame, ...patch.frame });
        }
        if (patch.style) node.style = { ...node.style, ...patch.style };
        for (const [k, v] of Object.entries(patch)) {
          if (k !== "frame" && k !== "style") node[k] = v;
        }
      };
      (transient ? mutateTransient : mutate)(apply);
    },

    removeNode: (sel) =>
      mutate((d) => {
        const band = findBand(d, sel.bandId);
        if (!band) return;
        if (sel.kind === "shape") band.shapes = band.shapes.filter((s) => s.id !== sel.id);
        else band.elements = band.elements.filter((e) => e.id !== sel.id);
      }),

    duplicateNode: (sel) =>
      mutate((d) => {
        const band = findBand(d, sel.bandId);
        if (!band) return;
        const list = sel.kind === "shape" ? band.shapes : band.elements;
        const node = list.find((n) => n.id === sel.id);
        if (!node) return;
        const copy = cloneWithNewIds(node);
        copy.frame = clampFrame({ ...copy.frame, x: copy.frame.x + 16, y: copy.frame.y + 16 });
        list.push(copy);
      }),

    // Shapes render in array order; later = closer to content. Content always
    // sits above ALL shapes — that invariant lives in the render layers.
    reorderShape: (bandId, shapeId, dir) =>
      mutate((d) => {
        const band = findBand(d, bandId);
        if (!band) return;
        const i = band.shapes.findIndex((s) => s.id === shapeId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= band.shapes.length) return;
        const [s] = band.shapes.splice(i, 1);
        band.shapes.splice(j, 0, s);
      }),

    deleteSelection: () => {
      const { selected } = get();
      if (!selected) return;
      if (selected.kind === "band") {
        const band = get().schema.bands.find((b) => b.id === selected.bandId);
        const count = (band?.elements.length ?? 0) + (band?.shapes.length ?? 0);
        if (count > 0 && !window.confirm(`Delete "${band.name}" and its ${count} item(s)?`)) {
          return;
        }
        get().removeBand(selected.bandId);
      } else {
        get().removeNode(selected);
      }
      set({ selected: null });
    },

    nudgeSelection: (dx, dy) => {
      const { selected, schema } = get();
      if (!selected || selected.kind === "band") return;
      const band = schema.bands.find((b) => b.id === selected.bandId);
      const list = selected.kind === "shape" ? band?.shapes : band?.elements;
      const node = list?.find((n) => n.id === selected.id);
      if (!node) return;
      get().updateNode(selected, {
        frame: { x: node.frame.x + dx, y: node.frame.y + dy },
      });
    },

    bandHeights: () => {
      const { schema } = get();
      return (schema?.bands ?? []).map((b) => ({ id: b.id, h: bandHeight(b) }));
    },
  };
});
