import { useEffect, useRef, useState } from "react";
import { hasToken, loadWalkthrough, saveWalkthrough } from "../api";
import { STARTER_TEMPLATE } from "./model";
import { useWalkthroughStore } from "./store";
import WCanvas from "./WCanvas";
import WInspector from "./WInspector";
import WPalette from "./WPalette";
import WTopBar from "./WTopBar";

const AUTOSAVE_DEBOUNCE_MS = 1500;

// The data-capture form designer. Self-contained: own boot, autosave, and
// keyboard handling. Boot is guarded so switching to Report mode and back
// preserves unsaved in-memory work, and a flush-on-leave keeps the server
// current.
export default function WalkthroughEditor() {
  const template = useWalkthroughStore((s) => s.template);
  const name = useWalkthroughStore((s) => s.name);
  const dirty = useWalkthroughStore((s) => s.dirty);
  const [fatal, setFatal] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    if (useWalkthroughStore.getState().template) return; // keep in-memory work
    (async () => {
      try {
        const data = await loadWalkthrough();
        const tpl = data?.schema ?? structuredClone(STARTER_TEMPLATE);
        useWalkthroughStore
          .getState()
          .loadTemplate(tpl, data?.name ?? "Walkthrough");
        useWalkthroughStore.getState().setSaveState(hasToken ? "idle" : "local");
      } catch (e) {
        setFatal(e?.message ?? "Could not load your form.");
      }
    })();
  }, []);

  useEffect(
    () => () => {
      const st = useWalkthroughStore.getState();
      if (st.dirty && hasToken) {
        saveWalkthrough({ name: st.name, schema: st.template }).catch(() => {});
      }
    },
    [],
  );

  useEffect(() => {
    if (!template || !dirty) return;
    const st = useWalkthroughStore.getState();
    if (st.saveState === "conflict") return;
    if (st.saveState !== "local") st.setSaveState("dirty");

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const state = useWalkthroughStore.getState();
      if (state.saveState !== "local") state.setSaveState("saving");
      try {
        const res = await saveWalkthrough({
          name: state.name,
          schema: state.template,
        });
        state.markClean();
        state.setSaveState(res?.local ? "local" : "saved");
      } catch (e) {
        state.setSaveState(e?.conflict ? "conflict" : "error");
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer.current);
  }, [template, name, dirty]);

  useEffect(() => {
    function onKey(e) {
      const st = useWalkthroughStore.getState();
      const inField = e.target.closest?.(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (e.key === "Escape") {
        st.deselect();
        return;
      }
      if (inField) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        if (st.selected) {
          e.preventDefault();
          if (st.selected.kind === "field") {
            st.duplicateField(st.selected.sectionId, st.selected.fieldId);
          } else {
            st.duplicateSection(st.selected.sectionId);
          }
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selected) {
          e.preventDefault();
          st.deleteSelection();
        }
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
          This link may have expired — generate a fresh one from Kensa →
          Settings → Form Builder.
        </span>
      </div>
    );
  }
  if (!template) {
    return <div className="fatal">Loading…</div>;
  }

  return (
    <div className="shell">
      <WTopBar />
      <WPalette />
      <div className="canvas-wrap">
        <WCanvas />
      </div>
      <WInspector />
      <div className="statusbar">
        <span>Click a field type to add it to the selected section</span>
        <span>Drag the ⠿ handle to reorder</span>
        <span>The page shows exactly what your inspectors will see</span>
        <span>Del = delete · Ctrl+Z = undo · Ctrl+D = duplicate</span>
      </div>
    </div>
  );
}
