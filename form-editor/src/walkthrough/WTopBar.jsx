import { useState } from "react";
import { hasToken, publishWalkthrough } from "../api";
import ModeSwitch from "../components/ModeSwitch";
import { useWalkthroughStore } from "./store";

const SAVE_LABELS = {
  idle: "",
  dirty: "Unsaved changes…",
  saving: "Saving…",
  saved: "All changes saved",
  error: "Save failed — retrying",
  conflict: "Conflict — reload needed",
  local: "Local preview",
};

export default function WTopBar() {
  const name = useWalkthroughStore((s) => s.name);
  const setName = useWalkthroughStore((s) => s.setName);
  const undo = useWalkthroughStore((s) => s.undo);
  const redo = useWalkthroughStore((s) => s.redo);
  const canUndo = useWalkthroughStore((s) => s.past.length > 0);
  const canRedo = useWalkthroughStore((s) => s.future.length > 0);
  const saveState = useWalkthroughStore((s) => s.saveState);
  const [publishState, setPublishState] = useState("idle");

  async function handlePublish() {
    if (publishState === "publishing") return;
    if (
      !window.confirm(
        "Publish this form? New inspections will use it from now on. " +
          "In-progress inspections keep the form they started with.",
      )
    ) {
      return;
    }
    setPublishState("publishing");
    try {
      await publishWalkthrough();
      setPublishState("done");
      setTimeout(() => setPublishState("idle"), 2200);
    } catch (_) {
      setPublishState("error");
      setTimeout(() => setPublishState("idle"), 3000);
    }
  }

  return (
    <div className="topbar">
      <span className="logo">Zanbi</span>
      <ModeSwitch />
      <input
        className="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Form name"
      />
      <button className="btn icon" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        ↩
      </button>
      <button className="btn icon" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        ↪
      </button>
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
