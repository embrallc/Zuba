import { useEffect, useRef, useState } from "react";
import { walkthroughToReport } from "../../../shared/walkthroughToReport";
import { hasToken, loadTemplate, loadWalkthrough, saveTemplate } from "../api";
import { starterTemplate } from "../schema";
import { useEditorStore } from "../store";
import { useWalkthroughStore } from "../walkthrough/store";
import Canvas from "./Canvas";
import Inspector from "./Inspector";
import Palette from "./Palette";
import TopBar from "./TopBar";

const AUTOSAVE_DEBOUNCE_MS = 1500;

// The printed-report layout designer (the original editor). Unchanged in
// behavior; the only additions vs. the old App are (a) a boot guard so
// switching modes and back doesn't reload over unsaved in-memory work, and
// (b) a flush-on-leave so the server has the latest when you switch away.
export default function ReportEditor() {
  const schema = useEditorStore((s) => s.schema);
  const name = useEditorStore((s) => s.name);
  const dirty = useEditorStore((s) => s.dirty);
  const [fatal, setFatal] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        // Refresh the binding source from the LIVE walkthrough form every time
        // Report mode mounts. The walkthrough store persists across the mode
        // switch, so its current fields are already in memory — reading them
        // here (not the debounced/persisted copy) means a field you just added
        // in Form mode shows up in the report's data-field palette and enables
        // "Build from my form" immediately, without a reload. This runs even
        // when the report schema is already loaded and the first-boot block
        // below is skipped. Falls back to the persisted walkthrough on a cold
        // first boot (e.g. a fresh page load straight into Report mode).
        const liveWt = useWalkthroughStore.getState().template;
        let wtSchema = liveWt ?? null;
        if (!wtSchema) {
          const wt = await loadWalkthrough().catch(() => null);
          wtSchema = wt?.schema ?? null;
        }
        if (wtSchema) useEditorStore.getState().setWalkthroughSchema(wtSchema);

        // Already loaded earlier this session (e.g. returned from walkthrough
        // mode) — keep the in-memory report schema, don't reload over it.
        if (useEditorStore.getState().schema) return;

        // First boot: load the saved report; a brand-new org with no report yet
        // gets one auto-built from their form, not a blank/legacy placeholder.
        const data = await loadTemplate();
        const schema =
          data?.schema ??
          (wtSchema ? walkthroughToReport(wtSchema) : starterTemplate());
        useEditorStore.getState().loadSchema(schema, data?.name ?? undefined);
        useEditorStore.getState().setSaveState(hasToken ? "idle" : "local");
      } catch (e) {
        setFatal(e?.message ?? "Could not load your template.");
      }
    })();
  }, []);

  // Flush any pending edit when leaving this mode.
  useEffect(
    () => () => {
      const st = useEditorStore.getState();
      if (st.dirty && hasToken) {
        saveTemplate({ name: st.name, schema: st.schema }).catch(() => {});
      }
    },
    [],
  );

  useEffect(() => {
    if (!schema || !dirty) return;
    const st = useEditorStore.getState();
    if (st.saveState === "conflict") return;
    if (st.saveState !== "local") st.setSaveState("dirty");

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const state = useEditorStore.getState();
      if (state.saveState !== "local") state.setSaveState("saving");
      try {
        const res = await saveTemplate({ name: state.name, schema: state.schema });
        state.markClean();
        state.setSaveState(res?.local ? "local" : "saved");
      } catch (e) {
        state.setSaveState(e?.conflict ? "conflict" : "error");
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer.current);
  }, [schema, name, dirty]);

  useEffect(() => {
    function onKey(e) {
      const st = useEditorStore.getState();
      const inField = e.target.closest?.(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (e.key === "Escape") {
        if (st.editingTextId) st.stopEditText();
        else st.deselect();
        return;
      }
      if (inField || st.editingTextId) return;

      const mod = e.ctrlKey || e.metaKey;
      const hasMulti = st.selectedIds.length >= 2;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) st.ungroupSelection();
        else st.groupSelection();
      } else if (mod && e.key.toLowerCase() === "d") {
        if (st.selected && st.selected.kind !== "band") {
          e.preventDefault();
          st.duplicateNode(st.selected);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selected || hasMulti) {
          e.preventDefault();
          st.deleteSelection();
        }
      } else if (
        e.key.startsWith("Arrow") &&
        ((st.selected && st.selected.kind !== "band") || hasMulti)
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = {
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
        }[e.key];
        st.nudgeSelection(d[0], d[1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (fatal) {
    return (
      <div className="fatal">
        <b>Couldn't open the Form Builder</b>
        <span>{fatal}</span>
        <span>
          This link may have expired — generate a fresh one from Zanbi →
          Settings → Form Builder.
        </span>
      </div>
    );
  }
  if (!schema) {
    return <div className="fatal">Loading…</div>;
  }

  return (
    <div className="shell">
      <TopBar />
      <Palette />
      <Canvas />
      <Inspector />
      <div className="statusbar">
        <span>Drag items from the left panel onto the page</span>
        <span>Double-click text to edit</span>
        <span>Alt = free placement (no snap)</span>
        <span>Del = delete · Ctrl+Z = undo · Ctrl+D = duplicate</span>
      </div>
    </div>
  );
}
