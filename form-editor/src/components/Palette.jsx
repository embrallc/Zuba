import { bindingGroups } from "../bindings";
import { MIME, setPayload } from "../dnd";
import { useEditorStore } from "../store";

function DragItem({ mime, payload, className = "", children }) {
  return (
    <div
      className={`palette-item ${className}`}
      draggable
      onDragStart={(e) => setPayload(e, mime, payload)}
    >
      {children}
    </div>
  );
}

export default function Palette() {
  const walkthroughSchema = useEditorStore((s) => s.walkthroughSchema);
  const groups = bindingGroups(walkthroughSchema);
  return (
    <div className="palette">
      <h3>Sections</h3>
      <div className="palette-grid">
        <DragItem
          mime={MIME.band}
          payload={{ bandKind: "static" }}
          className="wide band-static"
        >
          <span className="glyph">▭</span> Static Section
        </DragItem>
        <DragItem
          mime={MIME.band}
          payload={{ bandKind: "repeatable" }}
          className="wide band-repeat"
        >
          <span className="glyph">⟳</span> Repeating Section
        </DragItem>
      </div>
      <div className="hint">
        Repeating sections stamp out once per walkthrough section (Basement,
        Roof, …) when the report generates.
      </div>

      <h3>Elements</h3>
      <div className="palette-grid">
        <DragItem mime={MIME.element} payload={{ type: "text" }}>
          <span className="glyph">T</span> Text
        </DragItem>
        <DragItem mime={MIME.element} payload={{ type: "field" }}>
          <span className="glyph">▁</span> Field Line
        </DragItem>
        <DragItem mime={MIME.element} payload={{ type: "divider" }}>
          <span className="glyph">—</span> Divider
        </DragItem>
        <DragItem mime={MIME.element} payload={{ type: "photoGrid" }}>
          <span className="glyph">🖼</span> Photo Grid
        </DragItem>
        <DragItem mime={MIME.element} payload={{ type: "image" }}>
          <span className="glyph">▣</span> Image / Logo
        </DragItem>
      </div>

      <h3>Shapes</h3>
      <div className="palette-grid">
        <DragItem mime={MIME.shape} payload={{ shape: "rect" }}>
          <span className="glyph">▢</span> Rectangle
        </DragItem>
        <DragItem mime={MIME.shape} payload={{ shape: "ellipse" }}>
          <span className="glyph">◯</span> Ellipse
        </DragItem>
        <DragItem mime={MIME.shape} payload={{ shape: "line" }}>
          <span className="glyph">╱</span> Line
        </DragItem>
      </div>
      <div className="hint">Shapes always sit behind text and fields.</div>

      <h3>Data Fields</h3>
      <div className="hint">
        Drag onto the page for a standalone value, or drop inside a text block
        to mix with your own words.
      </div>
      {groups.length === 0 && (
        <div className="hint">
          Design your walkthrough form first — its fields appear here to drop
          into the report.
        </div>
      )}
      {groups.map((group) => (
        <div key={group.id}>
          <h3>
            {group.label}
            {group.scope === "section" ? " · repeats" : ""}
          </h3>
          <div>
            {group.fields.map((f) => (
              <span
                key={f.key}
                className="binding-pill"
                draggable
                onDragStart={(e) =>
                  setPayload(e, MIME.binding, {
                    key: f.key,
                    label: f.label,
                    type: f.type,
                    scope: f.scope,
                  })
                }
                title={
                  f.scope === "section"
                    ? "Repeats per walkthrough section — place inside a Repeating Section"
                    : f.label
                }
              >
                ⠿ {f.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
