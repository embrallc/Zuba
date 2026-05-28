import { create } from "zustand";

export const useUIStore = create((set) => ({
  isAddInspectionOpen: false,
  editingInspectionSk: null,
  // Pre-filled date/time when tapping empty space in the week view
  prefilledDateTime: null,
  isLoading: false,

  openAdd: (prefilledDateTime = null) =>
    set({
      isAddInspectionOpen: true,
      editingInspectionSk: null,
      prefilledDateTime,
    }),

  openEdit: (sk) =>
    set({
      isAddInspectionOpen: true,
      editingInspectionSk: sk,
      prefilledDateTime: null,
    }),

  closeInspection: () =>
    set({
      isAddInspectionOpen: false,
      editingInspectionSk: null,
      prefilledDateTime: null,
    }),

  setLoading: (val) => set({ isLoading: val }),
}));
