import { useState } from "react";
import { hasToken, publishTemplate } from "../api";
import { useEditorStore } from "../store";

const SAVE_LABELS = {
  idle: "",
  dirty: "Unsaved changes…",
  saving: "Saving…",
  saved: "All changes saved",
  error: "Save failed — retrying",
  conflict: "Conflict — reload needed",
  local: "Local preview",
};

export default function TopBar() {
  const name = useEditorStore((s) => s.name);
  const setName = useEditorStore((s) => s.setName);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const zoom = useEditorStore((s) => s.zoom);
  const setZoom = useEditorStore((s) => s.setZoom);
  const saveState = useEditorStore((s) => s.saveState);
  const [publishState, setPublishState] = useState("idle");

  async function handlePublish() {
    if (publishState === "publishing") return;
    if (
      !window.confirm(
        "Publish this layout? Generated reports will use it from now on.",
      )
    ) {
      return;
    }
    setPublishState("publishing");
    try {
      await publishTemplate();
      setPublishState("done");
      setTimeout(() => setPublishState("idle"), 2200);
    } catch (_) {
      setPublishState("error");
      setTimeout(() => setPublishState("idle"), 3000);
    }
  }

  return (
    <div className="topbar">
      <span className="logo">Kensa</span>
      <input
        className="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Template name"
      />
      <button className="btn icon" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        ↩
      </button>
      <button className="btn icon" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        ↪
      </button>
      <select
        className="zoom"
        value={zoom}
        onChange={(e) => setZoom(parseFloat(e.target.value))}
      >
        <option value={0.5}>50%</option>
        <option value={0.75}>75%</option>
        <option value={1}>100%</option>
        <option value={1.25}>125%</option>
        <option value={1.5}>150%</option>
      </select>
      <span className="spacer" />
      <span className={`savestate ${saveState}`}>{SAVE_LABELS[saveState] ?? ""}</span>
      {hasToken && (
        <button
          className="btn primary"
          onClick={handlePublish}
          disabled={publishState === "publishing"}
        >
          {publishState === "publishing"
            ? "Publishing…"
            : publishState === "done"
              ? "Published ✓"
              : publishState === "error"
                ? "Publish failed"
                : "Publish"}
        </button>
      )}
    </div>
  );
}
