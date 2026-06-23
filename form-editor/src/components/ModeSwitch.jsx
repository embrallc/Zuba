import { useAppStore } from "../appStore";

// Segmented switch between the two org designers. Lives in each editor's top
// bar so it's always reachable.
export default function ModeSwitch() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  return (
    <div className="modeswitch" role="tablist" aria-label="Designer">
      <button
        role="tab"
        aria-selected={mode === "walkthrough"}
        className={mode === "walkthrough" ? "active" : ""}
        onClick={() => setMode("walkthrough")}
      >
        Walkthrough Form
      </button>
      <button
        role="tab"
        aria-selected={mode === "report"}
        className={mode === "report" ? "active" : ""}
        onClick={() => setMode("report")}
      >
        Report Layout
      </button>
    </div>
  );
}
