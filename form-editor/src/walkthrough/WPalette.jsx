import { DND_NEW_FIELD, PALETTE_FIELDS } from "./model";
import { useWalkthroughStore } from "./store";

// Resolve which section a click-to-add field should land in: the selected
// section (or the section of the selected field), else the last section.
function targetSectionId(state) {
  if (state.selected?.sectionId) return state.selected.sectionId;
  const secs = state.template?.sections ?? [];
  return secs.length ? secs[secs.length - 1].id : null;
}

export default function WPalette() {
  const addSection = useWalkthroughStore((s) => s.addSection);
  const addField = useWalkthroughStore((s) => s.addField);

  function handleAddField(type) {
    const state = useWalkthroughStore.getState();
    const secId = targetSectionId(state);
    if (!secId) {
      window.alert("Add a section first, then add fields into it.");
      return;
    }
    addField(secId, type);
  }

  return (
    <div className="palette">
      <h3>Sections</h3>
      <div className="wt-add-col">
        <button
          className="palette-item wide band-static"
          onClick={() => addSection("static")}
          title="A section that appears once"
        >
          <span className="glyph">▬</span> Static Section
        </button>
        <button
          className="palette-item wide band-repeat"
          onClick={() => addSection("repeatable")}
          title="A section the inspector can add multiple times (per area)"
        >
          <span className="glyph">⧉</span> Repeating Section
        </button>
      </div>

      <h3>Fields</h3>
      <p className="hint">
        Click to add to the selected section, or drag onto the page.
      </p>
      <div className="palette-grid">
        {PALETTE_FIELDS.map((f) => (
          <div
            key={f.type}
            className="palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_NEW_FIELD, f.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => handleAddField(f.type)}
            title={f.label}
          >
            <span className="glyph">{f.glyph}</span> {f.label}
          </div>
        ))}
      </div>

      <h3>Tips</h3>
      <p className="hint">
        <b>Repeating sections</b> get stamped out once per area the inspector
        walks — design it once, it repeats automatically in the report.
      </p>
      <p className="hint">
        The page in the middle is a live preview: it shows exactly what your
        inspectors will tap through on their phones.
      </p>
    </div>
  );
}
