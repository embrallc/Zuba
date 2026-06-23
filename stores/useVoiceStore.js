import { create } from "zustand";

// Global voice-dictation state. Lives independently from any screen so the
// recognition session can survive navigation between the inspection form and
// the photo markup editor without restarting.
//
// Field-switch model:
// - `currentField` is the field that should receive new transcripts.
// - When the user focuses a *different* field mid-utterance, we don't change
//   `currentField` right away — we stash the new field in `pendingField` and
//   ask the engine to flush. The engine then emits one last final result
//   (with proper capitalization/punctuation) which commits cleanly into the
//   previous field. Once the engine's `end` event fires, we apply the
//   pending switch and the next utterance starts fresh in the new field.
// - `fieldBaseline` is whatever was in `currentField` at the moment we
//   started writing into it (focus moment, or right after the last final).
//   Streamed text gets appended on top of this baseline.
// - `lastTranscript` is the latest transcript the engine emitted for the
//   current in-flight utterance. Empty means there is no in-flight utterance.
export const useVoiceStore = create((set, get) => ({
  enabled: false,
  listening: false,
  currentField: null, // { token: Symbol, getValue, setValue }
  pendingField: null, // queued field switch awaiting engine flush
  fieldBaseline: "",
  lastTranscript: "",

  setEnabled: (val) => set({ enabled: val }),
  setListening: (val) => set({ listening: val }),

  setField: (field) =>
    set((s) => {
      // Re-focusing the same field — leave streaming state alone.
      if (s.currentField && field && s.currentField.token === field.token) {
        return s;
      }
      // Different field while an utterance is in-flight → defer the switch
      // so the trailing final lands in the previous field, not this one.
      if (s.currentField && field && s.lastTranscript) {
        return { pendingField: field };
      }
      // No in-flight utterance → switch immediately.
      return {
        currentField: field,
        pendingField: null,
        fieldBaseline: field?.getValue?.() ?? "",
        lastTranscript: "",
      };
    }),

  // Called by VoiceFab when the engine has fully ended (post-flush). Applies
  // any queued field switch and resets streaming state for the new field.
  applyPendingField: () =>
    set((s) => {
      if (!s.pendingField) return s;
      return {
        currentField: s.pendingField,
        pendingField: null,
        fieldBaseline: s.pendingField?.getValue?.() ?? "",
        lastTranscript: "",
      };
    }),

  clearField: () =>
    set({
      currentField: null,
      pendingField: null,
      fieldBaseline: "",
      lastTranscript: "",
    }),

  // Used by useVoiceField's unmount cleanup: only clear if the unmounting
  // field is the one currently registered (or pending).
  clearFieldIfMatches: (token) =>
    set((s) => {
      const updates = {};
      if (s.currentField?.token === token) {
        updates.currentField = null;
        updates.fieldBaseline = "";
        updates.lastTranscript = "";
      }
      if (s.pendingField?.token === token) {
        updates.pendingField = null;
      }
      return Object.keys(updates).length > 0 ? updates : s;
    }),

  // Called on every interim and final result from the engine. Streams the
  // transcript into the currently-registered field; on `isFinal` it bakes
  // the result into a new baseline so the next utterance appends cleanly.
  handleTranscript: (transcript, isFinal) => {
    set({ lastTranscript: transcript });
    const { currentField, fieldBaseline } = get();

    if (!currentField) {
      if (isFinal) set({ lastTranscript: "" });
      return;
    }

    const newPortion = transcript.trim();
    const needsSpace =
      fieldBaseline.length > 0 &&
      !/\s$/.test(fieldBaseline) &&
      newPortion.length > 0;
    const combined =
      fieldBaseline + (needsSpace ? " " : "") + newPortion;
    currentField.setValue(combined);

    if (isFinal) {
      set({ fieldBaseline: combined, lastTranscript: "" });
    }
  },

  reset: () =>
    set({
      enabled: false,
      listening: false,
      currentField: null,
      pendingField: null,
      fieldBaseline: "",
      lastTranscript: "",
    }),
}));
