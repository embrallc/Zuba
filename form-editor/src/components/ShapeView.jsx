import { useEditorStore } from "../store";
import { RESIZE_HANDLES, useDragNode } from "./hooks";

export default function ShapeView({ bandId, shape }) {
  const selected = useEditorStore(
    (s) => s.selected?.kind === "shape" && s.selected.id === shape.id,
  );
  const { onPointerDown } = useDragNode({ kind: "shape", bandId, id: shape.id });

  const { frame, style } = shape;
  let body;
  if (shape.shape === "line") {
    body = (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `calc(50% - ${(style.strokeWidth ?? 2) / 2}px)`,
          height: style.strokeWidth ?? 2,
          background: style.stroke ?? "#111827",
          borderRadius: 2,
          opacity: style.opacity ?? 1,
        }}
      />
    );
  } else {
    body = (
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: style.fill ?? "#EEF0FF",
          border:
            style.stroke && style.stroke !== "transparent"
              ? `${style.strokeWidth ?? 1}px solid ${style.stroke}`
              : "none",
          borderRadius: shape.shape === "ellipse" ? "50%" : (style.radius ?? 0),
          opacity: style.opacity ?? 1,
        }}
      />
    );
  }

  return (
    <div
      className="node"
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, cursor: "move" }}
      onPointerDown={(e) => onPointerDown(e, "move")}
    >
      {body}
      {selected && (
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
