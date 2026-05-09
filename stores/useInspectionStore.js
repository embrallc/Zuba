import dayjs from "dayjs";
import { create } from "zustand";

function insertSorted(sortedIds, inspection, inspectionsMap) {
  const newTime = dayjs(inspection.ScheduledAt).valueOf();
  const idx = sortedIds.findIndex(
    (id) => dayjs(inspectionsMap[id]?.ScheduledAt).valueOf() > newTime,
  );
  const result = [...sortedIds];
  if (idx === -1) {
    result.push(inspection.InspectionSk);
  } else {
    result.splice(idx, 0, inspection.InspectionSk);
  }
  return result;
}

export const useInspectionStore = create((set, get) => ({
  // Keyed by InspectionSk for O(1) lookup
  inspections: {},
  // InspectionSks sorted by ScheduledAt ASC
  sortedIds: [],

  load: (inspectionArray) => {
    const map = {};
    inspectionArray.forEach((i) => {
      map[i.InspectionSk] = i;
    });
    const sortedIds = [...inspectionArray]
      .sort(
        (a, b) =>
          dayjs(a.ScheduledAt).valueOf() - dayjs(b.ScheduledAt).valueOf(),
      )
      .map((i) => i.InspectionSk);
    set({ inspections: map, sortedIds });
  },

  add: (inspection) => {
    set((state) => {
      const inspections = {
        ...state.inspections,
        [inspection.InspectionSk]: inspection,
      };
      const sortedIds = insertSorted(
        state.sortedIds,
        inspection,
        state.inspections,
      );
      return { inspections, sortedIds };
    });
  },

  update: (inspection) => {
    set((state) => {
      const inspections = {
        ...state.inspections,
        [inspection.InspectionSk]: inspection,
      };
      // Remove and re-insert in case ScheduledAt changed
      const without = state.sortedIds.filter(
        (id) => id !== inspection.InspectionSk,
      );
      const sortedIds = insertSorted(without, inspection, inspections);
      return { inspections, sortedIds };
    });
  },

  remove: (sk) => {
    set((state) => {
      const { [sk]: _removed, ...inspections } = state.inspections;
      const sortedIds = state.sortedIds.filter((id) => id !== sk);
      return { inspections, sortedIds };
    });
  },

  getSorted: () => {
    const { inspections, sortedIds } = get();
    return sortedIds.map((id) => inspections[id]).filter(Boolean);
  },

  getById: (sk) => get().inspections[sk] ?? null,
}));
