import { useState } from "react";
import { DND_MOVE_FIELD, DND_NEW_FIELD, SEVERITY_LEVELS } from "./model";
import { useWalkthroughStore } from "./store";

// ── Field preview ────────────────────────────────────────────────────────────
// Renders each field as the inspector will actually see it on their phone, so
// the canvas doubles as a live preview. Display-only (no real inputs).
function FieldPreview({ field }) {
  const { type, label, config = {} } = field;
  switch (type) {
    case "heading":
      return <div className="wt-fp-heading">{label || "Heading"}</div>;

    case "text": {
      const variant = config.variant ?? "line";
      return (
        <div className="wt-fp">
          <div className="wt-fp-label">{label}</div>
          {variant === "line" && <div className="wt-fp-line" />}
          {variant === "box" && <div className="wt-fp-box" />}
          {variant === "multiline" && <div className="wt-fp-box tall" />}
        </div>
      );
    }

    case "toggle":
      return (
        <div className="wt-fp wt-fp-inline">
          <div className="wt-fp-label nomargin">{label}</div>
          <div className="wt-fp-toggle">
            <span className="on">Yes</span>
            <span>No</span>
          </div>
        </div>
      );

    case "radio":
    case "checkbox": {
      const opts = config.options ?? [];
      return (
        <div className="wt-fp">
          <div className="wt-fp-label">{label}</div>
          <div className="wt-fp-opts">
            {opts.length === 0 && (
              <div className="wt-fp-emptyopt">No options yet — add some →</div>
            )}
            {opts.map((o) => (
              <div className="wt-fp-opt" key={o.id}>
                <span className={`wt-fp-mark ${type}`} />
                <span>{o.label}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "photo":
      return (
        <div className="wt-fp">
          <div className="wt-fp-label">
            {label}
            {config.notes && <span className="wt-fp-cap"> · note per photo</span>}
          </div>
          <div className="wt-fp-photos">
            {[0, 1, 2].map((i) => (
              <div className="wt-fp-tile" key={i}>
                <span>📷</span>
                <span className="t">Tap to add</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "severity":
      return (
        <div className="wt-fp">
          <div className="wt-fp-label">{label}</div>
          <div className="wt-fp-sev">
            {SEVERITY_LEVELS.map((lvl) => (
              <span
                className="wt-sev-chip"
                key={lvl.key}
                style={{ color: lvl.color, background: lvl.bg, borderColor: lvl.color }}
              >
                {lvl.label}
              </span>
            ))}
          </div>
        </div>
      );

    default:
      return <div className="wt-fp-label">{label}</div>;
  }
}

// ── Field row ────────────────────────────────────────────────────────────────
function WField({ section, field }) {
  const selected = useWalkthroughStore(
    (s) =>
      s.selected?.kind === "field" &&
      s.selected.fieldId === field.id,
  );
  const select = useWalkthroughStore((s) => s.select);
  const removeField = useWalkthroughStore((s) => s.removeField);

  return (
    <div
      className={`wt-field ${selected ? "selected" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MOVE_FIELD, `${section.id}:${field.id}`);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        e.stopPropagation();
        select({ kind: "field", sectionId: section.id, fieldId: field.id });
      }}
    >
      <span className="wt-field-handle" title="Drag to reorder">
        ⠿
      </span>
      <div className="wt-field-body">
        <FieldPreview field={field} />
      </div>
      <button
        className="wt-field-del"
        title="Delete field"
        onClick={(e) => {
          e.stopPropagation();
          removeField(section.id, field.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

// Insertion index from pointer Y against the field rows in a container.
function dropIndexFromPointer(containerEl, clientY) {
  const rows = [...containerEl.querySelectorAll(".wt-field")];
  let i = 0;
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (clientY > r.top + r.height / 2) i += 1;
    else break;
  }
  return i;
}

// ── Section card ─────────────────────────────────────────────────────────────
function WSection({ section, index, count }) {
  const selected = useWalkthroughStore(
    (s) => s.selected?.kind === "section" && s.selected.sectionId === section.id,
  );
  const select = useWalkthroughStore((s) => s.select);
  const updateSection = useWalkthroughStore((s) => s.updateSection);
  const moveSection = useWalkthroughStore((s) => s.moveSection);
  const duplicateSection = useWalkthroughStore((s) => s.duplicateSection);
  const removeSection = useWalkthroughStore((s) => s.removeSection);
  const addField = useWalkthroughStore((s) => s.addField);
  const moveField = useWalkthroughStore((s) => s.moveField);

  const [dropAt, setDropAt] = useState(null); // insertion index, or null

  const repeatable = section.kind === "repeatable";

  function onDragOver(e) {
    if (
      !e.dataTransfer.types.includes(DND_NEW_FIELD) &&
      !e.dataTransfer.types.includes(DND_MOVE_FIELD)
    ) {
      return;
    }
    e.preventDefault();
    const body = e.currentTarget;
    setDropAt(dropIndexFromPointer(body, e.clientY));
  }

  function onDrop(e) {
    e.preventDefault();
    const at = dropAt;
    setDropAt(null);
    const newType = e.dataTransfer.getData(DND_NEW_FIELD);
    if (newType) {
      addField(section.id, newType, at ?? undefined);
      return;
    }
    const move = e.dataTransfer.getData(DND_MOVE_FIELD);
    if (move) {
      const [fromSec, fieldId] = move.split(":");
      moveField(fromSec, fieldId, section.id, at ?? undefined);
    }
  }

  function confirmRemove() {
    const n = section.fields.length;
    if (n > 0 && !window.confirm(`Delete "${section.title}" and its ${n} field(s)?`)) {
      return;
    }
    removeSection(section.id);
  }

  return (
    <div
      className={`wt-section ${repeatable ? "repeatable" : ""} ${selected ? "selected" : ""}`}
      onClick={() => select({ kind: "section", sectionId: section.id })}
    >
      <div className="wt-section-head">
        <input
          className="wt-section-title"
          value={section.title}
          onChange={(e) => updateSection(section.id, { title: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          placeholder="Section title"
        />
        <span className={`pill ${repeatable ? "repeat" : "static"}`}>
          {repeatable ? "REPEATS" : "ONCE"}
        </span>
        <div className="wt-section-tools" onClick={(e) => e.stopPropagation()}>
          <button title="Move up" disabled={index === 0} onClick={() => moveSection(section.id, -1)}>
            ↑
          </button>
          <button
            title="Move down"
            disabled={index === count - 1}
            onClick={() => moveSection(section.id, 1)}
          >
            ↓
          </button>
          <button title="Duplicate" onClick={() => duplicateSection(section.id)}>
            ⧉
          </button>
          <button title="Delete section" className="danger" onClick={confirmRemove}>
            ✕
          </button>
        </div>
      </div>

      <div className="wt-fields" onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setDropAt(null)}>
        {section.fields.length === 0 && dropAt == null && (
          <div className="wt-empty">
            Click a field type on the left to add it here — or drag one in.
          </div>
        )}
        {section.fields.map((f, i) => (
          <div key={f.id}>
            {dropAt === i && <div className="wt-drop" />}
            <WField section={section} field={f} />
          </div>
        ))}
        {dropAt === section.fields.length && <div className="wt-drop" />}
      </div>

      {repeatable && (
        <div className="wt-add-instance" title="In the app, inspectors tap this to add another">
          ＋ {section.addLabel || "Add Item"}
        </div>
      )}
    </div>
  );
}

// ── Canvas ───────────────────────────────────────────────────────────────────
export default function WCanvas() {
  const sections = useWalkthroughStore((s) => s.template?.sections ?? []);
  const deselect = useWalkthroughStore((s) => s.deselect);
  const addSection = useWalkthroughStore((s) => s.addSection);

  return (
    <div className="wt-sheet" onClick={deselect}>
      {sections.length === 0 ? (
        <div className="wt-blank">
          <div className="wt-blank-title">Build your walkthrough form</div>
          <div className="wt-blank-sub">
            Start by adding a section, then drop fields into it.
          </div>
          <div className="wt-blank-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn" onClick={() => addSection("static")}>
              ▬ Static Section
            </button>
            <button className="btn primary" onClick={() => addSection("repeatable")}>
              ⧉ Repeating Section
            </button>
          </div>
        </div>
      ) : (
        sections.map((sec, i) => (
          <WSection key={sec.id} section={sec} index={i} count={sections.length} />
        ))
      )}
    </div>
  );
}
