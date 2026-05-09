import { create } from "zustand";

export const useMapStore = create((set) => ({
  isOpen: false,
  // 'all' plots every inspection; 'single' plots one specific inspection
  mode: "all",
  targetInspectionSk: null,
  // 'all' or an ISO date string (YYYY-MM-DD) to filter pins by date
  activeDateFilter: "all",

  openGlobal: () =>
    set({
      isOpen: true,
      mode: "all",
      targetInspectionSk: null,
      activeDateFilter: "all",
    }),

  openForInspection: (sk) =>
    set({ isOpen: true, mode: "single", targetInspectionSk: sk }),

  close: () => set({ isOpen: false, targetInspectionSk: null }),

  setDateFilter: (date) => set({ activeDateFilter: date }),
}));
