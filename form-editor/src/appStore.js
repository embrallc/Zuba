import { create } from "zustand";

// Top-level editor mode. One token/link opens both org-level designers:
//   - "report"      → the printed-report layout designer (the original editor)
//   - "walkthrough" → the data-capture form designer (Phase 2)
// Each mode owns its own store, autosave, and keyboard handling; only the
// active one is mounted, so their global key listeners never collide.
export const useAppStore = create((set) => ({
  mode: "walkthrough",
  setMode: (mode) => set({ mode }),
}));
