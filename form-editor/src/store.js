import { current, produce } from "immer";
import { create } from "zustand";
import {
  bandGroups,
  bandHeight,
  clampFrame,
  cloneWithNewIds,
  descendantGroupIds,
  findNode,
  makeBand,
  makeGroup,
  objectBBox,
  objectLeafIds,
  pruneGroups,
  rootGroupOf,
  translateLeaves,
} from "./schema";

// History model: snapshot-based undo. Every discrete mutation pushes the
// prior schema onto `past`. Continuous interactions (drag/resize/typing)
// call beginHistory() ONCE at gesture start, then flow through transient
// updates that don't push — so one drag = one undo step.
const HISTORY_LIMIT = 60;

// Remove a set of top-level objects (elements/shapes/groups) from a band draft:
// drop their leaves + descendant group entries, then prune dangling refs.
function deleteObjectsInBand(band, objIds) {
  const leafIds = new Set();
  const groupIds = new Set();
  for (const oid of objIds) {
    for (const lid of objectLeafIds(band, oid)) leafIds.add(lid);
    for (const gid of descendantGroupIds(band, oid)) groupIds.add(gid);
  }
  band.elements = band.elements.filter((e) => !leafIds.has(e.id));
  band.shapes = band.shapes.filter((s) => !leafIds.has(s.id));
  if (band.groups) band.groups = band.groups.filter((g) => !groupIds.has(g.id));
  pruneGroups(band);
}

// Duplicate a group subtree in a band draft: clone all descendant leaves
// (offset +16) and descendant groups with fresh, remapped ids. Returns the new
// root group id.
function duplicateGroupInBand(band, groupId) {
  const idMap = new Map();
  const leafSet = new Set(objectLeafIds(band, groupId));
  // Clone leaves in their ORIGINAL array order — that's the paint/z-order.
  // Member order is the click order, NOT z-order, so cloning by member order can
  // drop a filled shape on top of its siblings. Snapshot each array first since
  // we push to it while iterating.
  for (const s of band.shapes.slice()) {
    if (!leafSet.has(s.id)) continue;
    const copy = structuredClone(current(s));
    copy.id = crypto.randomUUID();
    idMap.set(s.id, copy.id);
    copy.frame = clampFrame({ ...copy.frame, x: copy.frame.x + 16, y: copy.frame.y + 16 });
    band.shapes.push(copy);
  }
  for (const e of band.elements.slice()) {
    if (!leafSet.has(e.id)) continue;
    const copy = structuredClone(current(e));
    copy.id = crypto.randomUUID();
    idMap.set(e.id, copy.id);
    if (copy.frame)
      copy.frame = clampFrame({ ...copy.frame, x: copy.frame.x + 16, y: copy.frame.y + 16 });
    band.elements.push(copy);
  }
  // Children before parents so member refs resolve (reverse of pre-order).
  for (const gid of descendantGroupIds(band, groupId).reverse()) {
    const g = bandGroups(band).find((x) => x.id === gid);
    if (!g) continue;
    const ng = {
      id: crypto.randomUUID(),
      type: "group",
      memberIds: g.memberIds.map((m) => idMap.get(m) ?? m),
    };
    idMap.set(gid, ng.id);
    band.groups.push(ng);
  }
  return idMap.get(groupId);
}

// Set or clear a rich-text mark (bold/italic/underline) on EVERY text run of a
// text element's Tiptap content. Used for whole-box formatting from the panel.
function setTextMarkAll(el, markType, on) {
  if (!el?.content) return;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text") {
      const has = (n.marks ?? []).some((m) => m.type === markType);
      if (on && !has) n.marks = [...(n.marks ?? []), { type: markType }];
      else if (!on && has) n.marks = (n.marks ?? []).filter((m) => m.type !== markType);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(el.content);
}

// Whether every text run of a text element carries a given mark (for the panel's
// active state). False for an empty/textless box.
export function textMarkActive(el, markType) {
  if (el?.type !== "text") return false;
  const nodes = [];
  const collect = (n) => {
    if (n?.type === "text") nodes.push(n);
    if (Array.isArray(n?.content)) n.content.forEach(collect);
  };
  collect(el.content);
  return nodes.length > 0 && nodes.every((n) => (n.marks ?? []).some((m) => m.type === markType));
}

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

  // Resolve a clicked node id to its TOP-LEVEL object ref: the enclosing root
  // group if any, else the node itself. Clicking a grouped child selects the
  // whole group.
  const resolveTopLevel = (band, nodeId) => {
    const root = rootGroupOf(band, nodeId);
    if (root) return { kind: "group", id: root.id };
    const found = findNode(band, nodeId);
    return found ? { kind: found.kind, id: nodeId } : null;
  };

  return {
    schema: null,
    name: "Inspection Report",
    // The org's walkthrough template — loaded at boot so the report's binding
    // palette and field labels reflect the real fields the owner built.
    walkthroughSchema: null,
    selected: null, // {kind:"band"|"element"|"shape"|"group", bandId, id}
    // Multi-selection: top-level object ids within ONE band. length>=2 means
    // multi mode (selected is null). length<=1 collapses back into `selected`.
    selectedIds: [],
    selectionBandId: null,
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

    select: (selected) =>
      set({ selected, editingTextId: null, selectedIds: [], selectionBandId: null }),
    deselect: () =>
      set({ selected: null, editingTextId: null, selectedIds: [], selectionBandId: null }),

    // Plain click: select the TOP-LEVEL object (root group, or the node itself).
    selectResolved: ({ bandId, id }) => {
      const band = get().schema?.bands.find((b) => b.id === bandId);
      if (!band) return;
      const top = resolveTopLevel(band, id);
      if (!top) return;
      set({
        selected: { kind: top.kind, bandId, id: top.id },
        selectedIds: [],
        selectionBandId: null,
        editingTextId: null,
      });
    },

    // Ctrl/Cmd-click: toggle a top-level object in the multi-set (within one
    // band). Collapses to single selection at length 1, deselects at 0.
    toggleSelect: ({ bandId, id }) => {
      const { schema, selected, selectedIds, selectionBandId } = get();
      const band = schema?.bands.find((b) => b.id === bandId);
      if (!band) return;
      const top = resolveTopLevel(band, id);
      if (!top) return;

      let ids = [];
      if (selectedIds.length >= 2 && selectionBandId === bandId) {
        ids = [...selectedIds];
      } else if (selected && selected.bandId === bandId && selected.kind !== "band") {
        const curTop = resolveTopLevel(band, selected.id);
        if (curTop) ids = [curTop.id];
      }

      const i = ids.indexOf(top.id);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(top.id);

      if (ids.length === 0) {
        set({ selected: null, selectedIds: [], selectionBandId: null, editingTextId: null });
      } else if (ids.length === 1) {
        const only = resolveTopLevel(band, ids[0]) ?? { kind: "element", id: ids[0] };
        set({
          selected: { kind: only.kind, bandId, id: ids[0] },
          selectedIds: [],
          selectionBandId: null,
          editingTextId: null,
        });
      } else {
        set({ selected: null, selectedIds: ids, selectionBandId: bandId, editingTextId: null });
      }
    },

    // Entering text-edit is one undo step for the whole editing session.
    startEditText: (bandId, id) =>
      set((state) => ({
        ...pushHistory(state),
        selected: { kind: "element", bandId, id },
        selectedIds: [],
        selectionBandId: null,
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
        // current(): snapshot the draft to a plain object — structuredClone
        // (inside cloneWithNewIds) can't clone an immer draft/Proxy.
        d.bands.splice(i + 1, 0, cloneWithNewIds(current(d.bands[i])));
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
      set({
        selected: { kind: "element", bandId, id: element.id },
        selectedIds: [],
        selectionBandId: null,
      });
    },

    addShape: (bandId, shape) => {
      mutate((d) => {
        findBand(d, bandId)?.shapes.push(shape);
      });
      set({
        selected: { kind: "shape", bandId, id: shape.id },
        selectedIds: [],
        selectionBandId: null,
      });
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

    duplicateNode: (sel) => {
      if (sel.kind === "group") {
        let newId = null;
        mutate((d) => {
          const band = findBand(d, sel.bandId);
          if (band) newId = duplicateGroupInBand(band, sel.id);
        });
        if (newId)
          set({
            selected: { kind: "group", bandId: sel.bandId, id: newId },
            selectedIds: [],
            selectionBandId: null,
          });
        return;
      }
      mutate((d) => {
        const band = findBand(d, sel.bandId);
        if (!band) return;
        const list = sel.kind === "shape" ? band.shapes : band.elements;
        const node = list.find((n) => n.id === sel.id);
        if (!node) return;
        const copy = cloneWithNewIds(current(node));
        copy.frame = clampFrame({ ...copy.frame, x: copy.frame.x + 16, y: copy.frame.y + 16 });
        list.push(copy);
      });
    },

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
      const { selected, selectedIds, selectionBandId } = get();
      if (selectedIds.length >= 2 && selectionBandId) {
        mutate((d) => {
          const band = findBand(d, selectionBandId);
          if (band) deleteObjectsInBand(band, selectedIds);
        });
        set({ selected: null, selectedIds: [], selectionBandId: null });
        return;
      }
      if (!selected) return;
      if (selected.kind === "band") {
        const band = get().schema.bands.find((b) => b.id === selected.bandId);
        const count = (band?.elements.length ?? 0) + (band?.shapes.length ?? 0);
        if (count > 0 && !window.confirm(`Delete "${band.name}" and its ${count} item(s)?`)) {
          return;
        }
        get().removeBand(selected.bandId);
      } else {
        // element / shape / group — remove leaves + descendant groups + prune.
        mutate((d) => {
          const band = findBand(d, selected.bandId);
          if (band) deleteObjectsInBand(band, [selected.id]);
        });
      }
      set({ selected: null, selectedIds: [], selectionBandId: null });
    },

    nudgeSelection: (dx, dy) => {
      const { selected, selectedIds, selectionBandId } = get();
      if (selectedIds.length >= 2 && selectionBandId) {
        mutate((d) => {
          const band = findBand(d, selectionBandId);
          if (band) for (const oid of selectedIds) translateLeaves(band, oid, dx, dy);
        });
        return;
      }
      if (!selected || selected.kind === "band") return;
      if (selected.kind === "group") {
        mutate((d) => {
          const band = findBand(d, selected.bandId);
          if (band) translateLeaves(band, selected.id, dx, dy);
        });
        return;
      }
      const band = get().schema.bands.find((b) => b.id === selected.bandId);
      const list = selected.kind === "shape" ? band?.shapes : band?.elements;
      const node = list?.find((n) => n.id === selected.id);
      if (!node) return;
      get().updateNode(selected, {
        frame: { x: node.frame.x + dx, y: node.frame.y + dy },
      });
    },

    // ── Grouping / alignment (multi-select) ────────────────────────────────────
    // Drag helper: move one top-level object (group or node) by a delta. Callers
    // run beginHistory() at gesture start, then pass transient for each move.
    translateObjectBy: (bandId, objId, dx, dy, { transient = false } = {}) => {
      const apply = (d) => {
        const band = findBand(d, bandId);
        if (band) translateLeaves(band, objId, dx, dy);
      };
      (transient ? mutateTransient : mutate)(apply);
    },

    groupSelection: () => {
      const { selectedIds, selectionBandId } = get();
      if (!selectionBandId || selectedIds.length < 2) return;
      let newId = null;
      mutate((d) => {
        const band = findBand(d, selectionBandId);
        if (!band) return;
        if (!band.groups) band.groups = [];
        const g = makeGroup(selectedIds);
        band.groups.push(g);
        newId = g.id;
      });
      if (newId)
        set({
          selected: { kind: "group", bandId: selectionBandId, id: newId },
          selectedIds: [],
          selectionBandId: null,
        });
    },

    ungroupSelection: () => {
      const { selected } = get();
      if (!selected || selected.kind !== "group") return;
      const { bandId, id: groupId } = selected;
      let members = [];
      mutate((d) => {
        const band = findBand(d, bandId);
        if (!band?.groups) return;
        const g = band.groups.find((x) => x.id === groupId);
        if (!g) return;
        members = [...g.memberIds];
        band.groups = band.groups.filter((x) => x.id !== groupId);
      });
      // Promote the group's DIRECT members back (nested child groups survive).
      if (members.length >= 2) {
        set({ selected: null, selectedIds: members, selectionBandId: bandId });
      } else if (members.length === 1) {
        const band = get().schema.bands.find((b) => b.id === bandId);
        const top = band ? resolveTopLevel(band, members[0]) : null;
        set({
          selected: top ? { kind: top.kind, bandId, id: members[0] } : null,
          selectedIds: [],
          selectionBandId: null,
        });
      } else {
        set({ selected: null, selectedIds: [], selectionBandId: null });
      }
    },

    alignSelection: (edge) => {
      const { selectedIds, selectionBandId, schema } = get();
      if (!selectionBandId || selectedIds.length < 2) return;
      const band0 = schema.bands.find((b) => b.id === selectionBandId);
      if (!band0) return;
      const boxes = selectedIds.map((oid) => ({ oid, bb: objectBBox(band0, oid) }));
      const minLeft = Math.min(...boxes.map((b) => b.bb.x));
      const maxRight = Math.max(...boxes.map((b) => b.bb.x + b.bb.w));
      const minTop = Math.min(...boxes.map((b) => b.bb.y));
      const maxBottom = Math.max(...boxes.map((b) => b.bb.y + b.bb.h));
      const cx = (minLeft + maxRight) / 2;
      const cy = (minTop + maxBottom) / 2;
      const deltaFor = (bb) => {
        switch (edge) {
          case "left": return [minLeft - bb.x, 0];
          case "right": return [maxRight - (bb.x + bb.w), 0];
          case "hcenter": return [cx - (bb.x + bb.w / 2), 0];
          case "top": return [0, minTop - bb.y];
          case "bottom": return [0, maxBottom - (bb.y + bb.h)];
          case "vcenter": return [0, cy - (bb.y + bb.h / 2)];
          default: return [0, 0];
        }
      };
      mutate((d) => {
        const band = findBand(d, selectionBandId);
        if (!band) return;
        for (const { oid, bb } of boxes) {
          const [dx, dy] = deltaFor(bb);
          if (dx || dy) translateLeaves(band, oid, dx, dy);
        }
      });
    },

    distributeSelection: (axis) => {
      const { selectedIds, selectionBandId, schema } = get();
      if (!selectionBandId || selectedIds.length < 3) return;
      const band0 = schema.bands.find((b) => b.id === selectionBandId);
      if (!band0) return;
      const key = axis === "h" ? "x" : "y";
      const sizeKey = axis === "h" ? "w" : "h";
      const boxes = selectedIds
        .map((oid) => ({ oid, bb: objectBBox(band0, oid) }))
        .sort((a, b) => a.bb[key] - b.bb[key]);
      const first = boxes[0].bb[key];
      const last = boxes[boxes.length - 1].bb[key] + boxes[boxes.length - 1].bb[sizeKey];
      const totalSize = boxes.reduce((s, b) => s + b.bb[sizeKey], 0);
      const gap = (last - first - totalSize) / (boxes.length - 1);
      let cursor = first;
      const targets = boxes.map((b) => {
        const t = cursor;
        cursor += b.bb[sizeKey] + gap;
        return t;
      });
      mutate((d) => {
        const band = findBand(d, selectionBandId);
        if (!band) return;
        boxes.forEach((b, i) => {
          const delta = targets[i] - b.bb[key];
          if (delta) translateLeaves(band, b.oid, axis === "h" ? delta : 0, axis === "h" ? 0 : delta);
        });
      });
    },

    setGapSelection: (axis, gap) => {
      const { selectedIds, selectionBandId, schema } = get();
      if (!selectionBandId || selectedIds.length < 2) return;
      const band0 = schema.bands.find((b) => b.id === selectionBandId);
      if (!band0) return;
      const key = axis === "h" ? "x" : "y";
      const sizeKey = axis === "h" ? "w" : "h";
      const boxes = selectedIds
        .map((oid) => ({ oid, bb: objectBBox(band0, oid) }))
        .sort((a, b) => a.bb[key] - b.bb[key]);
      let pos = 0;
      const targets = boxes.map((b, i) => {
        if (i === 0) {
          pos = b.bb[key] + b.bb[sizeKey];
          return b.bb[key];
        }
        const t = pos + gap;
        pos = t + b.bb[sizeKey];
        return t;
      });
      mutate((d) => {
        const band = findBand(d, selectionBandId);
        if (!band) return;
        boxes.forEach((b, i) => {
          const delta = targets[i] - b.bb[key];
          if (delta) translateLeaves(band, b.oid, axis === "h" ? delta : 0, axis === "h" ? 0 : delta);
        });
      });
    },

    // Set a uniform width or height across the selection's top-level BARE nodes
    // (elements/shapes). Groups are skipped — group resize isn't a v1 feature.
    resizeSelection: (dim, value) => {
      const { selectedIds, selectionBandId } = get();
      if (!selectionBandId || selectedIds.length < 2) return;
      const key = dim === "h" ? "h" : "w";
      mutate((d) => {
        const band = findBand(d, selectionBandId);
        if (!band) return;
        for (const oid of selectedIds) {
          const found = findNode(band, oid);
          if (found && found.kind !== "group" && found.node.frame) {
            found.node.frame = clampFrame({ ...found.node.frame, [key]: value });
          }
        }
      });
    },

    // Whole-box rich-text formatting for a single text element: toggle a mark
    // (bold/italic/underline) across ALL its runs. If every run already has the
    // mark, it turns off; otherwise it turns on for all.
    toggleTextMark: (sel, markType) => {
      mutate((d) => {
        const band = findBand(d, sel.bandId);
        const el = band?.elements.find((e) => e.id === sel.id);
        if (!el || el.type !== "text") return;
        const nodes = [];
        const collect = (n) => {
          if (n?.type === "text") nodes.push(n);
          if (Array.isArray(n?.content)) n.content.forEach(collect);
        };
        collect(el.content);
        if (!nodes.length) return;
        const allOn = nodes.every((n) => (n.marks ?? []).some((m) => m.type === markType));
        setTextMarkAll(el, markType, !allOn);
      });
    },

    // Set bold across the current selection, honoring how each type stores it:
    // data fields use style.bold; text boxes use a bold mark on every run.
    applySharedBold: (on) => {
      const { selected, selectedIds, selectionBandId } = get();
      let bandId = null;
      let objIds = [];
      if (selectedIds.length >= 2 && selectionBandId) {
        bandId = selectionBandId;
        objIds = selectedIds;
      } else if (selected && selected.kind === "group") {
        bandId = selected.bandId;
        objIds = [selected.id];
      } else return;
      mutate((d) => {
        const band = findBand(d, bandId);
        if (!band) return;
        const leafIds = new Set(objIds.flatMap((oid) => objectLeafIds(band, oid)));
        for (const el of band.elements) {
          if (!leafIds.has(el.id)) continue;
          if (el.type === "field") el.style = { ...el.style, bold: on };
          else if (el.type === "text") setTextMarkAll(el, "bold", on);
        }
      });
    },

    // Apply a style patch to every text/field/element leaf under the current
    // selection (a group, or a multi-select). Shapes are left untouched.
    applySharedStyle: (patch) => {
      const { selected, selectedIds, selectionBandId } = get();
      let bandId = null;
      let objIds = [];
      if (selectedIds.length >= 2 && selectionBandId) {
        bandId = selectionBandId;
        objIds = selectedIds;
      } else if (selected && selected.kind === "group") {
        bandId = selected.bandId;
        objIds = [selected.id];
      } else return;
      mutate((d) => {
        const band = findBand(d, bandId);
        if (!band) return;
        const leafIds = new Set(objIds.flatMap((oid) => objectLeafIds(band, oid)));
        for (const el of band.elements) {
          if (leafIds.has(el.id)) el.style = { ...el.style, ...patch };
        }
      });
    },

    bandHeights: () => {
      const { schema } = get();
      return (schema?.bands ?? []).map((b) => ({ id: b.id, h: bandHeight(b) }));
    },
  };
});
