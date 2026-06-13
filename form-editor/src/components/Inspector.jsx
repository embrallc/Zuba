import { useRef, useState } from "react";
import { FORM_BINDINGS, bindingByKey } from "../../../shared/formBindings";
import { uploadAsset } from "../api";
import { useEditorStore } from "../store";

const SWATCHES = [
  "#111827",
  "#374151",
  "#6B7280",
  "#5C5CE8",
  "#16A34A",
  "#D97706",
  "#DC2626",
  "#FFFFFF",
  "#F3F4F6",
  "#EEF0FF",
];

function Num({ label, value, onChange, min = 0, step = 1 }) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="number"
        value={Math.round(value ?? 0)}
        min={min}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

function Swatches({ label, value, onChange }) {
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <label>{label}</label>
      <div className="swatches">
        {SWATCHES.map((c) => (
          <div
            key={c}
            className={`swatch ${value === c ? "active" : ""}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
        <input
          type="color"
          className="swatch"
          style={{ padding: 0, border: "1px solid var(--border)" }}
          value={/^#[0-9a-fA-F]{6}$/.test(value ?? "") ? value : "#111827"}
          onChange={(e) => onChange(e.target.value)}
          title="Custom color"
        />
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function FrameRows({ node, update }) {
  return (
    <>
      <div className="row2">
        <Num label="X" value={node.frame.x} onChange={(x) => update({ frame: { x } })} />
        <Num label="Y" value={node.frame.y} onChange={(y) => update({ frame: { y } })} />
      </div>
      <div className="row2">
        <Num label="W" value={node.frame.w} onChange={(w) => update({ frame: { w } })} />
        <Num label="H" value={node.frame.h} onChange={(h) => update({ frame: { h } })} />
      </div>
    </>
  );
}

function NodeActions() {
  const duplicateNode = useEditorStore((s) => s.duplicateNode);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const selected = useEditorStore((s) => s.selected);
  return (
    <>
      <hr />
      <div className="row">
        <button className="btn" onClick={() => duplicateNode(selected)}>
          Duplicate
        </button>
        <button className="btn danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    </>
  );
}

function BandPanel({ band }) {
  const updateBand = useEditorStore((s) => s.updateBand);
  const duplicateBand = useEditorStore((s) => s.duplicateBand);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const select = useEditorStore((s) => s.select);
  const reorderShape = useEditorStore((s) => s.reorderShape);

  return (
    <>
      <h2>Section</h2>
      <div className="row">
        <label>Name</label>
        <input
          type="text"
          value={band.name}
          onChange={(e) => updateBand(band.id, { name: e.target.value })}
        />
      </div>
      <div className="row">
        <label>Type</label>
        <Seg
          options={[
            { value: "static", label: "Static" },
            { value: "repeatable", label: "Repeats" },
          ]}
          value={band.kind}
          onChange={(kind) =>
            updateBand(band.id, {
              kind,
              repeat: kind === "repeatable" ? { collection: "sections" } : null,
            })
          }
        />
      </div>
      {band.kind === "repeatable" && (
        <p className="muted">
          Stamped once per walkthrough section in the generated report —
          Basement, Roof, Foundation each get their own copy with their own
          data.
        </p>
      )}
      <Num
        label="Min height"
        value={band.minHeightPx}
        min={48}
        onChange={(minHeightPx) => updateBand(band.id, { minHeightPx })}
      />
      {band.shapes.length > 0 && (
        <>
          <hr />
          <label>Background shapes</label>
          <ul className="layers">
            {band.shapes.map((s, i) => (
              <li key={s.id} onClick={() => select({ kind: "shape", bandId: band.id, id: s.id })}>
                <span
                  className="swatch"
                  style={{ background: s.style.fill, width: 14, height: 14 }}
                />
                {s.shape} {i + 1}
                <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                  <button
                    className="btn icon"
                    title="Send backward"
                    onClick={(e) => {
                      e.stopPropagation();
                      reorderShape(band.id, s.id, -1);
                    }}
                  >
                    ▼
                  </button>
                  <button
                    className="btn icon"
                    title="Bring forward"
                    onClick={(e) => {
                      e.stopPropagation();
                      reorderShape(band.id, s.id, 1);
                    }}
                  >
                    ▲
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <hr />
      <div className="row">
        <button className="btn" onClick={() => duplicateBand(band.id)}>
          Duplicate
        </button>
        <button className="btn danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    </>
  );
}

function ShapePanel({ shape, update }) {
  return (
    <>
      <h2>{shape.shape === "rect" ? "Rectangle" : shape.shape === "ellipse" ? "Ellipse" : "Line"}</h2>
      <FrameRows node={shape} update={update} />
      {shape.shape !== "line" && (
        <Swatches
          label="Fill"
          value={shape.style.fill}
          onChange={(fill) => update({ style: { fill } })}
        />
      )}
      <Swatches
        label={shape.shape === "line" ? "Color" : "Border"}
        value={shape.style.stroke}
        onChange={(stroke) => update({ style: { stroke } })}
      />
      <Num
        label={shape.shape === "line" ? "Thickness" : "Border width"}
        value={shape.style.strokeWidth}
        min={0}
        onChange={(strokeWidth) => update({ style: { strokeWidth } })}
      />
      {shape.shape === "rect" && (
        <Num
          label="Corner radius"
          value={shape.style.radius}
          min={0}
          onChange={(radius) => update({ style: { radius } })}
        />
      )}
      <div className="row">
        <label>Opacity</label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={shape.style.opacity ?? 1}
          onChange={(e) => update({ style: { opacity: parseFloat(e.target.value) } })}
        />
      </div>
      <NodeActions />
    </>
  );
}

// Browser-side processing: downscale to ≤1200px longest side, keep PNG (alpha
// survives) or JPEG. Output is what both the editor preview and the PDF
// generator consume — uploaded once to the org's form-assets storage.
const MAX_ASSET_DIMENSION = 1200;

async function processImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const isPng = file.type === "image/png";
  const scale = Math.min(1, MAX_ASSET_DIMENSION / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const contentType = isPng ? "image/png" : "image/jpeg";
  const out = canvas.toDataURL(contentType, isPng ? undefined : 0.85);
  return { dataBase64: out.split(",")[1], contentType, w, h };
}

function ImageUpload({ el, update }) {
  const fileRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | working | error

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setStatus("error");
      return;
    }
    setStatus("working");
    try {
      const processed = await processImageFile(file);
      const res = await uploadAsset(processed);
      update({ asset: { path: res.path, w: processed.w, h: processed.h } });
      setStatus("idle");
    } catch (_) {
      setStatus("error");
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: "none" }}
        onChange={handleFile}
      />
      <div className="row">
        <button
          className="btn"
          disabled={status === "working"}
          onClick={() => fileRef.current?.click()}
        >
          {status === "working"
            ? "Uploading…"
            : el.asset
              ? "Replace image"
              : "Upload image"}
        </button>
        {el.asset && (
          <button className="btn" onClick={() => update({ asset: null })}>
            Clear
          </button>
        )}
      </div>
      {status === "error" && (
        <div className="warn">
          Couldn't use that file — PNG or JPG only, and check your connection.
        </div>
      )}
      {el.asset?.w ? (
        <p className="muted">
          {el.asset.w} × {el.asset.h}px — drawn to fit the frame without
          stretching.
        </p>
      ) : (
        <p className="muted">
          PNG or JPG from your computer (company logo, badge, signature).
          Large files are scaled down automatically.
        </p>
      )}
    </>
  );
}

function ElementPanel({ band, el, update }) {
  const meta = el.binding ? bindingByKey(el.binding) : null;
  const invalid = !!meta && meta.scope === "section" && band.kind !== "repeatable";

  return (
    <>
      <h2>
        {el.type === "text"
          ? "Text"
          : el.type === "field"
            ? "Data Field"
            : el.type === "divider"
              ? "Divider"
              : el.type === "image"
                ? "Image"
                : "Photo Grid"}
      </h2>
      {invalid && (
        <div className="warn">
          "{meta.label}" repeats per walkthrough section, but this is a static
          section. Move it into a Repeating Section or it will be blank in
          reports.
        </div>
      )}
      <FrameRows node={el} update={update} />

      {el.type === "field" && (
        <>
          <div className="row">
            <label>Maps to</label>
            <select
              value={el.binding ?? ""}
              onChange={(e) => {
                const key = e.target.value || null;
                const f = key ? bindingByKey(key) : null;
                update({ binding: key, label: f?.label ?? "Blank line" });
              }}
            >
              <option value="">None (blank line)</option>
              {FORM_BINDINGS.groups.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="row">
            <label>Style</label>
            <Seg
              options={[
                { value: "underline", label: "Line" },
                { value: "box", label: "Box" },
                { value: "plain", label: "Plain" },
              ]}
              value={el.style.variant}
              onChange={(variant) => update({ style: { variant } })}
            />
          </div>
          <div className="row">
            <label>Bold</label>
            <Seg
              options={[
                { value: false, label: "Off" },
                { value: true, label: "On" },
              ]}
              value={!!el.style.bold}
              onChange={(bold) => update({ style: { bold } })}
            />
          </div>
        </>
      )}

      {(el.type === "text" || el.type === "field") && (
        <>
          <Num
            label="Font size"
            value={el.style.fontSize}
            min={7}
            onChange={(fontSize) => update({ style: { fontSize } })}
          />
          <div className="row">
            <label>Align</label>
            <Seg
              options={[
                { value: "left", label: "L" },
                { value: "center", label: "C" },
                { value: "right", label: "R" },
              ]}
              value={el.style.align ?? "left"}
              onChange={(align) => update({ style: { align } })}
            />
          </div>
          <Swatches
            label="Color"
            value={el.style.color}
            onChange={(color) => update({ style: { color } })}
          />
          {el.type === "text" && (
            <p className="muted">
              Double-click the text on the page to edit it — select words for
              bold / italic / underline / color, or drop a data field straight
              into a sentence.
            </p>
          )}
        </>
      )}

      {el.type === "image" && <ImageUpload el={el} update={update} />}

      {el.type === "divider" && (
        <>
          <Num
            label="Thickness"
            value={el.style.thickness}
            min={1}
            onChange={(thickness) => update({ style: { thickness } })}
          />
          <Swatches
            label="Color"
            value={el.style.color}
            onChange={(color) => update({ style: { color } })}
          />
        </>
      )}

      {el.type === "photoGrid" && (
        <>
          <div className="row">
            <label>Columns</label>
            <Seg
              options={[
                { value: 2, label: "2" },
                { value: 3, label: "3" },
                { value: 4, label: "4" },
              ]}
              value={el.style.cols}
              onChange={(cols) => update({ style: { cols } })}
            />
          </div>
          <Num
            label="Gap"
            value={el.style.gap}
            min={0}
            onChange={(gap) => update({ style: { gap } })}
          />
          <Num
            label="Corner radius"
            value={el.style.radius}
            min={0}
            onChange={(radius) => update({ style: { radius } })}
          />
          <div className="row">
            <label>Captions</label>
            <Seg
              options={[
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ]}
              value={!!el.style.captions}
              onChange={(captions) => update({ style: { captions } })}
            />
          </div>
          <p className="muted">
            Fills with each section's photos at generation time, growing rows
            as needed.
          </p>
        </>
      )}
      <NodeActions />
    </>
  );
}

export default function Inspector() {
  const schema = useEditorStore((s) => s.schema);
  const selected = useEditorStore((s) => s.selected);
  const updateNode = useEditorStore((s) => s.updateNode);
  const addBand = useEditorStore((s) => s.addBand);

  if (!schema) return <div className="inspector" />;

  const band = selected ? schema.bands.find((b) => b.id === selected.bandId) : null;

  let body;
  if (!selected || !band) {
    body = (
      <>
        <h2>Report Template</h2>
        <p className="muted">
          US Letter · {schema.bands.length} section
          {schema.bands.length === 1 ? "" : "s"}
        </p>
        <div className="row">
          <button className="btn" onClick={() => addBand("static")}>
            + Static
          </button>
          <button className="btn" onClick={() => addBand("repeatable")}>
            + Repeating
          </button>
        </div>
        <hr />
        <p className="muted">
          Select anything on the page to edit its properties here.
          <br />
          <br />
          Drag to move · handles to resize · Alt disables snapping · Del
          deletes · Ctrl+Z undo.
        </p>
      </>
    );
  } else if (selected.kind === "band") {
    body = <BandPanel band={band} />;
  } else if (selected.kind === "shape") {
    const shape = band.shapes.find((s) => s.id === selected.id);
    body = shape ? (
      <ShapePanel shape={shape} update={(patch) => updateNode(selected, patch)} />
    ) : null;
  } else {
    const el = band.elements.find((e) => e.id === selected.id);
    body = el ? (
      <ElementPanel band={band} el={el} update={(patch) => updateNode(selected, patch)} />
    ) : null;
  }

  return <div className="inspector">{body}</div>;
}
