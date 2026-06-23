import { create } from "zustand";

// Transient cross-screen handoffs for the walkthrough photo flow. expo-router
// has no "return a value from a screen", so the form drops a target here,
// navigates to the camera / markup editor, and reads the result back when it
// regains focus. Both are one-shot and cleared after the form consumes them.

// Camera capture: the form sets `target` (where the photos belong), the
// multi-capture camera screen hands back raw temp URIs in `captures`.
export const usePhotoCaptureStore = create((set) => ({
  target: null, // { inspectionSk, sectionId, instanceId, fieldId }
  captures: [], // [tempUri]
  beginCapture: (target) => set({ target, captures: [] }),
  setCaptures: (captures) => set({ captures }),
  clear: () => set({ target: null, captures: [] }),
}));

// Markup editor: the form opens photoedit for a specific photo id; the editor
// writes the resulting markup JSON back here instead of touching the (now
// removed) InspectionDetail table.
export const usePhotoMarkupStore = create((set) => ({
  result: null, // { photoId, markup } — markup is a JSON string or null
  setResult: (result) => set({ result }),
  clear: () => set({ result: null }),
}));
