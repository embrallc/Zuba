import { FIELD_TYPES, TEXT_VARIANTS } from "./model";
import { useWalkthroughStore } from "./store";

const VARIANT_LABELS = { line: "Underline", box: "Box", multiline: "Text area" };
const REQUIREABLE = new Set(["text", "toggle", "radio", "checkbox", "photo", "severity"]);

export default function WInspector() {
  const selected = useWalkthroughStore((s) => s.selected);
  const sections = useWalkthroughStore((s) => s.template?.sections ?? []);

  const updateSection = useWalkthroughStore((s) => s.updateSection);
  const setSectionKind = useWalkthroughStore((s) => s.setSectionKind);
  const duplicateSection = useWalkthroughStore((s) => s.duplicateSection);
  const removeSection = useWalkthroughStore((s) => s.removeSection);

  const updateField = useWalkthroughStore((s) => s.updateField);
  const updateFieldConfig = useWalkthroughStore((s) => s.updateFieldConfig);
  const duplicateField = useWalkthroughStore((s) => s.duplicateField);
  const removeField = useWalkthroughStore((s) => s.removeField);
  const addOption = useWalkthroughStore((s) => s.addOption);
  const updateOption = useWalkthroughStore((s) => s.updateOption);
  const moveOption = useWalkthroughStore((s) => s.moveOption);
  const removeOption = useWalkthroughStore((s) => s.removeOption);

  if (!selected) {
    return (
      <div className="inspector">
        <h2>Form Designer</h2>
        <p className="muted">
          Select a section or field to edit it here. Everything you change shows
          up instantly on the page — that page is exactly what your inspectors
          will see in the app.
        </p>
        <hr />
        <p className="muted">
          <b>Static</b> sections appear once per inspection. <b>Repeating</b>{" "}
          sections can be added as many times as the inspector needs (one per
          area of the home).
        </p>
      </div>
    );
  }

  const section = sections.find((s) => s.id === selected.sectionId);
  if (!section) {
    return (
      <div className="inspector">
        <h2>Nothing selected</h2>
      </div>
    );
  }

  // ── Section selected ───────────────────────────────────────────────────────
  if (selected.kind === "section") {
    return (
      <div className="inspector">
        <h2>Section</h2>
        <label>Title</label>
        <input
          type="text"
          className="grow"
          value={section.title}
          onChange={(e) => updateSection(section.id, { title: e.target.value })}
        />

        <div style={{ height: 10 }} />
        <label>Type</label>
        <div className="seg" style={{ marginTop: 4 }}>
          <button
            className={section.kind === "static" ? "active" : ""}
            onClick={() => setSectionKind(section.id, "static")}
          >
            Static
          </button>
          <button
            className={section.kind === "repeatable" ? "active" : ""}
            onClick={() => setSectionKind(section.id, "repeatable")}
          >
            Repeating
          </button>
        </div>

        {section.kind === "repeatable" && (
          <>
            <div style={{ height: 10 }} />
            <label>"Add" button label</label>
            <input
              type="text"
              className="grow"
              value={section.addLabel ?? ""}
              placeholder="Add Item"
              onChange={(e) => updateSection(section.id, { addLabel: e.target.value })}
            />
            <p className="muted" style={{ marginTop: 6 }}>
              Inspectors tap this to add another copy of this section — once per
              area they inspect.
            </p>
          </>
        )}

        <hr />
        <div className="row">
          <span className="muted">{section.fields.length} field(s)</span>
          <button className="btn" onClick={() => duplicateSection(section.id)}>
            Duplicate
          </button>
        </div>
        <button
          className="btn danger"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            const n = section.fields.length;
            if (n > 0 && !window.confirm(`Delete "${section.title}" and its ${n} field(s)?`)) return;
            removeSection(section.id);
          }}
        >
          Delete section
        </button>
      </div>
    );
  }

  // ── Field selected ─────────────────────────────────────────────────────────
  const field = section.fields.find((f) => f.id === selected.fieldId);
  if (!field) return <div className="inspector"><h2>Nothing selected</h2></div>;

  const sid = section.id;
  const fid = field.id;
  const cfg = field.config ?? {};
  const isChoice = field.type === "radio" || field.type === "checkbox";

  return (
    <div className="inspector">
      <h2>{FIELD_TYPES[field.type]?.label ?? "Field"}</h2>

      {field.type !== "heading" ? (
        <>
          <label>{isChoice ? "Question" : "Label"}</label>
          <input
            type="text"
            className="grow"
            value={field.label}
            onChange={(e) => updateField(sid, fid, { label: e.target.value })}
          />
        </>
      ) : (
        <>
          <label>Heading text</label>
          <input
            type="text"
            className="grow"
            value={field.label}
            onChange={(e) => updateField(sid, fid, { label: e.target.value })}
          />
        </>
      )}

      {/* text variant */}
      {field.type === "text" && (
        <>
          <div style={{ height: 10 }} />
          <label>Style</label>
          <div className="seg" style={{ marginTop: 4 }}>
            {TEXT_VARIANTS.map((v) => (
              <button
                key={v}
                className={(cfg.variant ?? "line") === v ? "active" : ""}
                onClick={() => updateFieldConfig(sid, fid, { variant: v })}
              >
                {VARIANT_LABELS[v] ?? v}
              </button>
            ))}
          </div>
        </>
      )}

      {/* photo options */}
      {field.type === "photo" && (
        <div className="row" style={{ marginTop: 12 }}>
          <label>Note under each photo</label>
          <input
            type="checkbox"
            checked={cfg.notes !== false}
            onChange={(e) => updateFieldConfig(sid, fid, { notes: e.target.checked })}
          />
        </div>
      )}

      {/* severity note */}
      {field.type === "severity" && (
        <p className="muted" style={{ marginTop: 10 }}>
          Uses your standard severity scale (OK · Low · Medium · Critical). The
          report colors each level automatically.
        </p>
      )}

      {/* options editor */}
      {isChoice && (
        <>
          <hr />
          <label>Options</label>
          <div className="wt-opts">
            {(cfg.options ?? []).map((o, i) => (
              <div className="wt-opt-row" key={o.id}>
                <input
                  type="text"
                  value={o.label}
                  onChange={(e) => updateOption(sid, fid, o.id, e.target.value)}
                />
                <button
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => moveOption(sid, fid, o.id, -1)}
                >
                  ↑
                </button>
                <button
                  title="Move down"
                  disabled={i === (cfg.options.length - 1)}
                  onClick={() => moveOption(sid, fid, o.id, 1)}
                >
                  ↓
                </button>
                <button
                  title="Remove option"
                  className="danger"
                  onClick={() => removeOption(sid, fid, o.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 6 }} onClick={() => addOption(sid, fid)}>
            ＋ Add option
          </button>
        </>
      )}

      {/* required */}
      {REQUIREABLE.has(field.type) && (
        <div className="row" style={{ marginTop: 12 }}>
          <label>Required</label>
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => updateField(sid, fid, { required: e.target.checked })}
          />
        </div>
      )}

      <hr />
      <div className="row">
        <button className="btn" onClick={() => duplicateField(sid, fid)}>
          Duplicate
        </button>
        <button className="btn danger" onClick={() => removeField(sid, fid)}>
          Delete
        </button>
      </div>
    </div>
  );
}
