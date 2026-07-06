import { current, produce } from "immer";
import { create } from "zustand";
import {
  cloneFieldWithNewIds,
  cloneSectionWithNewIds,
  makeField,
  makeOption,
  makeSection,
} from "./model";

// Snapshot-based undo, mirroring the report editor's store: each discrete
// mutation pushes the prior template onto `past`. One field's worth of typing
// in the inspector is debounced by React, but each committed change is its
// own step — acceptable for a low-frequency structural editor.
const HISTORY_LIMIT = 60;

export const useWalkthroughStore = create((set, get) => {
  const pushHistory = (state) => ({
    past: [
      ...state.past.slice(-HISTORY_LIMIT + 1),
      structuredClone(state.template),
    ],
    future: [],
  });

  const mutate = (fn) =>
    set((state) => ({
      ...pushHistory(state),
      template: produce(state.template, fn),
      dirty: true,
    }));

  const findSection = (d, id) => d.sections.find((s) => s.id === id);
  const findField = (d, secId, fId) =>
    findSection(d, secId)?.fields.find((f) => f.id === fId);

  return {
    template: null,
    name: "Walkthrough",
    selected: null, // { kind:"section"|"field", sectionId, fieldId? }
    saveState: "idle",
    dirty: false,
    past: [],
    future: [],

    loadTemplate: (template, name) =>
      set({
        template,
        ...(name ? { name } : {}),
        past: [],
        future: [],
        dirty: false,
        selected: null,
      }),

    setName: (name) => set({ name, dirty: true }),
    setSaveState: (saveState) => set({ saveState }),
    markClean: () => set({ dirty: false }),
    select: (selected) => set({ selected }),
    deselect: () => set({ selected: null }),

    undo: () =>
      set((state) => {
        if (!state.past.length) return state;
        const past = [...state.past];
        const prev = past.pop();
        return {
          past,
          future: [structuredClone(state.template), ...state.future].slice(
            0,
            HISTORY_LIMIT,
          ),
          template: prev,
          selected: null,
          dirty: true,
        };
      }),

    redo: () =>
      set((state) => {
        if (!state.future.length) return state;
        const [next, ...future] = state.future;
        return {
          past: [...state.past, structuredClone(state.template)].slice(
            -HISTORY_LIMIT,
          ),
          future,
          template: next,
          selected: null,
          dirty: true,
        };
      }),

    // ── Sections ───────────────────────────────────────────────────────────
    addSection: (kind) => {
      const sec = makeSection(kind);
      mutate((d) => {
        d.sections.push(sec);
      });
      set({ selected: { kind: "section", sectionId: sec.id } });
    },

    updateSection: (id, patch) =>
      mutate((d) => {
        const s = findSection(d, id);
        if (s) Object.assign(s, patch);
      }),

    setSectionKind: (id, kind) =>
      mutate((d) => {
        const s = findSection(d, id);
        if (!s) return;
        s.kind = kind;
        if (kind === "repeatable" && !s.addLabel) s.addLabel = "Add Item";
        if (kind === "static") delete s.addLabel;
      }),

    moveSection: (id, dir) =>
      mutate((d) => {
        const i = d.sections.findIndex((s) => s.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.sections.length) return;
        const [s] = d.sections.splice(i, 1);
        d.sections.splice(j, 0, s);
      }),

    duplicateSection: (id) => {
      let newId = null;
      mutate((d) => {
        const i = d.sections.findIndex((s) => s.id === id);
        if (i < 0) return;
        // current(): plain snapshot — structuredClone can't clone a draft.
        const copy = cloneSectionWithNewIds(current(d.sections[i]));
        newId = copy.id;
        d.sections.splice(i + 1, 0, copy);
      });
      if (newId) set({ selected: { kind: "section", sectionId: newId } });
    },

    removeSection: (id) =>
      mutate((d) => {
        d.sections = d.sections.filter((s) => s.id !== id);
      }),

    // ── Fields ─────────────────────────────────────────────────────────────
    addField: (sectionId, type, index) => {
      const field = makeField(type);
      mutate((d) => {
        const s = findSection(d, sectionId);
        if (!s) return;
        const i = index == null ? s.fields.length : index;
        s.fields.splice(i, 0, field);
      });
      set({ selected: { kind: "field", sectionId, fieldId: field.id } });
    },

    updateField: (sectionId, fieldId, patch) =>
      mutate((d) => {
        const f = findField(d, sectionId, fieldId);
        if (f) Object.assign(f, patch);
      }),

    updateFieldConfig: (sectionId, fieldId, patch) =>
      mutate((d) => {
        const f = findField(d, sectionId, fieldId);
        if (f) f.config = { ...(f.config ?? {}), ...patch };
      }),

    // Reorder within a section or move across sections. toIndex is computed
    // against the destination list's CURRENT state; when moving down within
    // the same list, removing the source first shifts the target left by one.
    moveField: (fromSec, fieldId, toSec, toIndex) =>
      mutate((d) => {
        const from = findSection(d, fromSec);
        if (!from) return;
        const idx = from.fields.findIndex((f) => f.id === fieldId);
        if (idx < 0) return;
        const [field] = from.fields.splice(idx, 1);
        const to = findSection(d, toSec) ?? from;
        let i = toIndex == null ? to.fields.length : toIndex;
        if (to === from && idx < i) i -= 1;
        i = Math.max(0, Math.min(i, to.fields.length));
        to.fields.splice(i, 0, field);
      }),

    duplicateField: (sectionId, fieldId) => {
      let newId = null;
      mutate((d) => {
        const s = findSection(d, sectionId);
        if (!s) return;
        const i = s.fields.findIndex((f) => f.id === fieldId);
        if (i < 0) return;
        const copy = cloneFieldWithNewIds(current(s.fields[i]));
        newId = copy.id;
        s.fields.splice(i + 1, 0, copy);
      });
      if (newId) set({ selected: { kind: "field", sectionId, fieldId: newId } });
    },

    removeField: (sectionId, fieldId) =>
      mutate((d) => {
        const s = findSection(d, sectionId);
        if (s) s.fields = s.fields.filter((f) => f.id !== fieldId);
      }),

    // ── Options (radio / checkbox) ───────────────────────────────────────────
    addOption: (sectionId, fieldId) =>
      mutate((d) => {
        const f = findField(d, sectionId, fieldId);
        if (!f) return;
        if (!Array.isArray(f.config.options)) f.config.options = [];
        f.config.options.push(makeOption(`Option ${f.config.options.length + 1}`));
      }),

    updateOption: (sectionId, fieldId, optionId, label) =>
      mutate((d) => {
        const f = findField(d, sectionId, fieldId);
        const o = f?.config?.options?.find((x) => x.id === optionId);
        if (o) o.label = label;
      }),

    moveOption: (sectionId, fieldId, optionId, dir) =>
      mutate((d) => {
        const opts = findField(d, sectionId, fieldId)?.config?.options;
        if (!opts) return;
        const i = opts.findIndex((o) => o.id === optionId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= opts.length) return;
        const [o] = opts.splice(i, 1);
        opts.splice(j, 0, o);
      }),

    removeOption: (sectionId, fieldId, optionId) =>
      mutate((d) => {
        const f = findField(d, sectionId, fieldId);
        if (f?.config?.options) {
          f.config.options = f.config.options.filter((o) => o.id !== optionId);
        }
      }),

    // ── Selection-aware delete (keyboard) ────────────────────────────────────
    deleteSelection: () => {
      const { selected, template } = get();
      if (!selected) return;
      if (selected.kind === "section") {
        const sec = template.sections.find((s) => s.id === selected.sectionId);
        const n = sec?.fields.length ?? 0;
        if (
          n > 0 &&
          !window.confirm(`Delete "${sec.title}" and its ${n} field(s)?`)
        ) {
          return;
        }
        get().removeSection(selected.sectionId);
      } else {
        get().removeField(selected.sectionId, selected.fieldId);
      }
      set({ selected: null });
    },
  };
});
