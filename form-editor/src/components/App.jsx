import { useEffect, useRef, useState } from "react";
import { hasToken, loadTemplate, saveTemplate } from "../api";
import { starterTemplate } from "../schema";
import { useEditorStore } from "../store";
import Canvas from "./Canvas";
import Inspector from "./Inspector";
import Palette from "./Palette";
import TopBar from "./TopBar";

const AUTOSAVE_DEBOUNCE_MS = 1500;

export default function App() {
  const schema = useEditorStore((s) => s.schema);
  const name = useEditorStore((s) => s.name);
  const dirty = useEditorStore((s) => s.dirty);
  const [fatal, setFatal] = useState(null);
  const saveTimer = useRef(null);

  // Boot: pull the org's draft (or seed the starter so first open isn't a
  // blank page).
  useEffect(() => {
    (async () => {
      try {
        const data = await loadTemplate();
        useEditorStore
          .getState()
          .loadSchema(data?.schema ?? starterTemplate(), data?.name ?? undefined);
        useEditorStore.getState().setSaveState(hasToken ? "idle" : "local");
      } catch (e) {
        setFatal(e?.message ?? "Could not load your template.");
      }
    })();
  }, []);

  // Autosave: debounce while the user works; one PUT per quiet period.
  useEffect(() => {
    if (!schema || !dirty) return;
    const st = useEditorStore.getState();
    if (st.saveState === "conflict") return; // require explicit reload
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

  // Global keyboard. Suppressed while typing in inputs or rich text.
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
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        if (st.selected && st.selected.kind !== "band") {
          e.preventDefault();
          st.duplicateNode(st.selected);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selected) {
          e.preventDefault();
          st.deleteSelection();
        }
      } else if (e.key.startsWith("Arrow") && st.selected && st.selected.kind !== "band") {
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
          This link may have expired — generate a fresh one from Kensa →
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
