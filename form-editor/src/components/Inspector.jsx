import { useEffect, useRef, useState } from "react";
import { uploadAsset } from "../api";
import {
  bindingByKey,
  bindingGroups,
  bindingMisplaced,
  photoBindings,
} from "../bindings";
import { repeatableSections } from "../../../shared/walkthroughToReport";
import { objectBBox } from "../schema";
import { textMarkActive, useEditorStore } from "../store";

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
  const walkthroughSchema = useEditorStore((s) => s.walkthroughSchema);

  const repeatables = repeatableSections(walkthroughSchema);

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
              // Default a new repeating band to the first walkthrough
              // repeatable section, if any.
              repeat:
                kind === "repeatable"
                  ? { sectionId: repeatables[0]?.id ?? null }
                  : null,
            })
          }
        />
      </div>
      {band.kind === "repeatable" && (
        <>
          <div className="row">
            <label>Repeats over</label>
            <select
              value={band.repeat?.sectionId ?? ""}
              onChange={(e) =>
                updateBand(band.id, { repeat: { sectionId: e.target.value || null } })
              }
            >
              <option value="">— pick a section —</option>
              {repeatables.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title || "Section"}
                </option>
              ))}
            </select>
          </div>
          {repeatables.length === 0 ? (
            <p className="warn">
              Your walkthrough form has no repeating sections yet. Add one in the
              Walkthrough Form designer, then this band can stamp it out.
            </p>
          ) : !band.repeat?.sectionId ? (
            <p className="warn">
              Pick which walkthrough section this repeats over, or its fields
              will be blank in reports.
            </p>
          ) : (
            <p className="muted">
              Stamped once per "{repeatables.find((s) => s.id === band.repeat.sectionId)?.title ?? "section"}"
              the inspector adds — each with its own data.
            </p>
          )}
        </>
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

// Whole-box bold / italic / underline for a text element (applies to all runs).
// Per-word formatting is still available by double-clicking into the text and
// using the floating toolbar — this is the quick "make the whole box bold" path.
// Disabled while editing, where the floating toolbar owns formatting.
function TextFormatButtons({ band, el }) {
  const toggle = useEditorStore((s) => s.toggleTextMark);
  const editing = useEditorStore((s) => s.editingTextId === el.id);
  const sel = { kind: "element", bandId: band.id, id: el.id };
  const mk = (label, mark, title) => (
    <button
      className={textMarkActive(el, mark) ? "active" : ""}
      disabled={editing}
      title={title}
      onClick={() => toggle(sel, mark)}
    >
      {label}
    </button>
  );
  return (
    <div className="row">
      <label>Format</label>
      <span className="seg">
        {mk(<b>B</b>, "bold", "Bold")}
        {mk(<i>I</i>, "italic", "Italic")}
        {mk(<u>U</u>, "underline", "Underline")}
      </span>
    </div>
  );
}

function ElementPanel({ band, el, update }) {
  const walkthroughSchema = useEditorStore((s) => s.walkthroughSchema);
  const groups = bindingGroups(walkthroughSchema);
  const photoOpts = photoBindings(walkthroughSchema);
  const meta = el.binding ? bindingByKey(el.binding, walkthroughSchema) : null;
  const invalid = bindingMisplaced(meta, band);

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
          "{meta.label}" comes from the "{meta.sectionTitle}" walkthrough
          section. Put it in a band that repeats over "{meta.sectionTitle}", or
          it will be blank in reports.
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
                const f = key ? bindingByKey(key, walkthroughSchema) : null;
                update({ binding: key, label: f?.label ?? "Blank line" });
              }}
            >
              <option value="">None (blank line)</option>
              {groups.map((g) => (
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
          {el.type === "text" && <TextFormatButtons band={band} el={el} />}
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
            <label>Photos from</label>
            <select
              value={el.binding ?? ""}
              onChange={(e) => update({ binding: e.target.value || null })}
            >
              <option value="">— pick a photo field —</option>
              {photoOpts.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.sectionTitle} · {p.label}
                </option>
              ))}
            </select>
          </div>
          {photoOpts.length === 0 && (
            <p className="warn">
              Add a Photos field to your walkthrough form, then this grid can
              show them.
            </p>
          )}
          {el.binding && bindingMisplaced(meta, band) && (
            <p className="warn">
              These photos come from "{meta?.sectionTitle}". Put this grid in a
              band that repeats over it.
            </p>
          )}
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
            Fills with the chosen field's photos at generation time, growing
            rows as needed.
          </p>
        </>
      )}
      <NodeActions />
    </>
  );
}

// Six-way align + (≥3) distribute for the current multi-selection. Operations
// act on the top-level members only — a group moves as a rigid body.
function AlignControls() {
  const align = useEditorStore((s) => s.alignSelection);
  const distribute = useEditorStore((s) => s.distributeSelection);
  const count = useEditorStore((s) => s.selectedIds.length);
  return (
    <>
      <label>Align</label>
      <div className="align-grid">
        <button className="btn icon" title="Left edges" onClick={() => align("left")}>L</button>
        <button className="btn icon" title="Horizontal centers" onClick={() => align("hcenter")}>C</button>
        <button className="btn icon" title="Right edges" onClick={() => align("right")}>R</button>
        <button className="btn icon" title="Top edges" onClick={() => align("top")}>T</button>
        <button className="btn icon" title="Vertical centers" onClick={() => align("vcenter")}>M</button>
        <button className="btn icon" title="Bottom edges" onClick={() => align("bottom")}>B</button>
      </div>
      {count >= 3 && (
        <>
          <label>Distribute evenly</label>
          <div className="row">
            <button className="btn" onClick={() => distribute("h")}>Horizontal</button>
            <button className="btn" onClick={() => distribute("v")}>Vertical</button>
          </div>
        </>
      )}
    </>
  );
}

// Set a uniform width/height across the whole selection. Seeded from the first
// selected object's size so "make them all match this one" is a single edit.
// (Groups are skipped — resize a group by ungrouping first.)
function SizeControls() {
  const resize = useEditorStore((s) => s.resizeSelection);
  const schema = useEditorStore((s) => s.schema);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const selectionBandId = useEditorStore((s) => s.selectionBandId);

  const band = schema?.bands.find((b) => b.id === selectionBandId);
  const firstBB = band && selectedIds[0] ? objectBBox(band, selectedIds[0]) : null;
  const seedW = firstBB ? Math.round(firstBB.w) : "";
  const seedH = firstBB ? Math.round(firstBB.h) : "";
  const selKey = selectedIds.join(",");

  const [w, setW] = useState(seedW);
  const [h, setH] = useState(seedH);
  // Re-seed only when the SET of selected objects changes (not on every edit),
  // so typing isn't clobbered by the apply that follows.
  useEffect(() => {
    setW(seedW);
    setH(seedH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  return (
    <>
      <label>Size (applies to all)</label>
      <div className="row2">
        <div className="row">
          <label>W</label>
          <input
            type="number"
            min={16}
            value={w}
            onChange={(e) => setW(e.target.value)}
            onBlur={() => w !== "" && resize("w", parseFloat(w))}
            onKeyDown={(e) => e.key === "Enter" && w !== "" && resize("w", parseFloat(w))}
          />
        </div>
        <div className="row">
          <label>H</label>
          <input
            type="number"
            min={10}
            value={h}
            onChange={(e) => setH(e.target.value)}
            onBlur={() => h !== "" && resize("h", parseFloat(h))}
            onKeyDown={(e) => e.key === "Enter" && h !== "" && resize("h", parseFloat(h))}
          />
        </div>
      </div>
    </>
  );
}

// Re-space the selection to an exact pixel gap along an axis (first item fixed).
function GapControls() {
  const setGap = useEditorStore((s) => s.setGapSelection);
  const [h, setH] = useState(12);
  const [v, setV] = useState(12);
  return (
    <>
      <label>Even gap (px)</label>
      <div className="row">
        <label>Across</label>
        <input type="number" min={0} value={h} onChange={(e) => setH(parseFloat(e.target.value) || 0)} />
        <button className="btn" onClick={() => setGap("h", h)}>Set</button>
      </div>
      <div className="row">
        <label>Down</label>
        <input type="number" min={0} value={v} onChange={(e) => setV(parseFloat(e.target.value) || 0)} />
        <button className="btn" onClick={() => setGap("v", v)}>Set</button>
      </div>
    </>
  );
}

// Shared styling applied to every text/field member (no single current value,
// so these are "set" controls that write to all).
function SharedStyle() {
  const applyShared = useEditorStore((s) => s.applySharedStyle);
  const applyBold = useEditorStore((s) => s.applySharedBold);
  const [size, setSize] = useState("");
  const commitSize = () => {
    const n = parseFloat(size);
    if (n) applyShared({ fontSize: n });
  };
  return (
    <>
      <label>Apply to all text</label>
      <div className="row">
        <label>Font size</label>
        <input
          type="number"
          min={7}
          placeholder="—"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          onBlur={commitSize}
          onKeyDown={(e) => e.key === "Enter" && commitSize()}
        />
      </div>
      <div className="row">
        <label>Align</label>
        <Seg
          options={[
            { value: "left", label: "L" },
            { value: "center", label: "C" },
            { value: "right", label: "R" },
          ]}
          value={null}
          onChange={(align) => applyShared({ align })}
        />
      </div>
      <div className="row">
        <label>Bold</label>
        <Seg
          options={[
            { value: false, label: "Off" },
            { value: true, label: "On" },
          ]}
          value={null}
          onChange={(bold) => applyBold(bold)}
        />
      </div>
      <Swatches label="Color" value={null} onChange={(color) => applyShared({ color })} />
    </>
  );
}

function MultiSelectPanel() {
  const count = useEditorStore((s) => s.selectedIds.length);
  const group = useEditorStore((s) => s.groupSelection);
  const del = useEditorStore((s) => s.deleteSelection);
  return (
    <>
      <h2>{count} items selected</h2>
      <p className="muted">Align, size, or space these, or group them so they move as one.</p>
      <AlignControls />
      <SizeControls />
      <GapControls />
      <hr />
      <SharedStyle />
      <hr />
      <button className="btn primary block" onClick={group}>
        ⧉ Group (Ctrl+G)
      </button>
      <div className="row">
        <button className="btn danger" onClick={del}>Delete all</button>
      </div>
    </>
  );
}

function GroupPanel({ band, group }) {
  const ungroup = useEditorStore((s) => s.ungroupSelection);
  const duplicateNode = useEditorStore((s) => s.duplicateNode);
  const del = useEditorStore((s) => s.deleteSelection);
  const translate = useEditorStore((s) => s.translateObjectBy);
  const bb = objectBBox(band, group.id);
  return (
    <>
      <h2>Group</h2>
      <p className="muted">{group.memberIds.length} items · moves and restyles as one.</p>
      <p className="note-guide">
        The dashed outline is a guide — it won't appear on the report.
      </p>
      <div className="row2">
        <Num label="X" value={bb.x} onChange={(x) => translate(band.id, group.id, x - bb.x, 0)} />
        <Num label="Y" value={bb.y} onChange={(y) => translate(band.id, group.id, 0, y - bb.y)} />
      </div>
      <SharedStyle />
      <hr />
      <div className="row">
        <button
          className="btn"
          onClick={() => duplicateNode({ kind: "group", bandId: band.id, id: group.id })}
        >
          Duplicate
        </button>
        <button className="btn" onClick={ungroup}>
          Ungroup (Ctrl+Shift+G)
        </button>
      </div>
      <div className="row">
        <button className="btn danger" onClick={del}>Delete group</button>
      </div>
    </>
  );
}

export default function Inspector() {
  const schema = useEditorStore((s) => s.schema);
  const selected = useEditorStore((s) => s.selected);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const selectionBandId = useEditorStore((s) => s.selectionBandId);
  const updateNode = useEditorStore((s) => s.updateNode);
  const addBand = useEditorStore((s) => s.addBand);

  if (!schema) return <div className="inspector" />;

  // Multi-selection takes precedence over any single selection.
  if (selectedIds.length >= 2 && selectionBandId) {
    return (
      <div className="inspector">
        <MultiSelectPanel />
      </div>
    );
  }

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
          Drag to move · handles to resize · Ctrl-click to multi-select · Alt
          disables snapping · Del deletes · Ctrl+Z undo.
        </p>
      </>
    );
  } else if (selected.kind === "band") {
    body = <BandPanel band={band} />;
  } else if (selected.kind === "group") {
    const group = (band.groups ?? []).find((g) => g.id === selected.id);
    body = group ? <GroupPanel band={band} group={group} /> : null;
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
