import { bindingByKey } from "../../../shared/formBindings";
import { assetUrl } from "../api";
import { useEditorStore } from "../store";
import TextElement from "./TextElement";
import { RESIZE_HANDLES, useDragNode } from "./hooks";

function FieldBody({ el }) {
  const s = el.style ?? {};
  const meta = el.binding ? bindingByKey(el.binding) : null;
  const label = meta?.label ?? el.label ?? "Blank line";
  return (
    <div
      className={`el-field v-${s.variant ?? "underline"} ${el.binding ? "" : "unbound"}`}
      style={{
        fontSize: s.fontSize ?? 13,
        color: s.color ?? "#111827",
        fontWeight: s.bold ? 700 : 400,
        justifyContent:
          s.align === "center" ? "center" : s.align === "right" ? "flex-end" : "flex-start",
      }}
    >
      <span className="chip">{el.binding ? `{${label}}` : " "}</span>
    </div>
  );
}

function PhotoGridBody({ el }) {
  const s = el.style ?? {};
  const cols = s.cols ?? 3;
  const rows = Math.max(1, Math.min(3, Math.round(el.frame.h / 130)));
  const tiles = Array.from({ length: cols * rows });
  return (
    <div
      className="photo-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: s.gap ?? 12,
      }}
    >
      {tiles.map((_, i) => (
        <div key={i} className="photo-tile" style={{ borderRadius: s.radius ?? 10 }}>
          <span style={{ fontSize: 18 }}>📷</span>
          <span>Photo</span>
          {s.captions && <span className="cap">Photo note</span>}
        </div>
      ))}
    </div>
  );
}

export default function ElementView({ band, el }) {
  const selected = useEditorStore(
    (s) => s.selected?.kind === "element" && s.selected.id === el.id,
  );
  const editing = useEditorStore((s) => s.editingTextId === el.id);
  const startEditText = useEditorStore((s) => s.startEditText);
  const { onPointerDown } = useDragNode({ kind: "element", bandId: band.id, id: el.id });

  // A per-section field placed in a static band can't resolve at generation
  // time — flag it loudly but don't block (the user may be mid-rearrange).
  const meta = el.binding ? bindingByKey(el.binding) : null;
  const invalid = !!meta && meta.scope === "section" && band.kind !== "repeatable";

  let body;
  switch (el.type) {
    case "text":
      body = <TextElement bandId={band.id} el={el} editing={editing} />;
      break;
    case "field":
      body = <FieldBody el={el} />;
      break;
    case "divider":
      body = (
        <div className="el-divider" style={{ width: "100%", height: "100%" }}>
          <div
            className="rule"
            style={{
              height: el.style?.thickness ?? 2,
              background: el.style?.color ?? "#E5E7EB",
              borderRadius: 2,
            }}
          />
        </div>
      );
      break;
    case "photoGrid":
      body = <PhotoGridBody el={el} />;
      break;
    case "image": {
      const src = el.asset?.path ? assetUrl(el.asset.path) : null;
      body = src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            opacity: el.style?.opacity ?? 1,
            pointerEvents: "none",
          }}
        />
      ) : (
        <div className="photo-tile" style={{ width: "100%", height: "100%" }}>
          <span style={{ fontSize: 18 }}>▣</span>
          <span>Image — upload in the panel →</span>
        </div>
      );
      break;
    }
    default:
      body = null;
  }

  return (
    <div
      className={`node ${invalid ? "invalid" : ""}`}
      style={{
        left: el.frame.x,
        top: el.frame.y,
        width: el.frame.w,
        height: el.frame.h,
        cursor: editing ? "auto" : "move",
      }}
      onPointerDown={(e) => {
        if (editing) return;
        onPointerDown(e, "move");
      }}
      onDoubleClick={(e) => {
        if (el.type === "text" && !editing) {
          e.stopPropagation();
          startEditText(band.id, el.id);
        }
      }}
    >
      {body}
      {selected && !editing && (
        <>
          <div className="sel-ring" />
          {RESIZE_HANDLES.map((h) => (
            <div
              key={h.mode}
              className="handle"
              style={h.style}
              onPointerDown={(e) => onPointerDown(e, h.mode)}
            />
          ))}
        </>
      )}
    </div>
  );
}
