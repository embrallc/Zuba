import { useRef } from "react";
import { bandHeight, makeElement, makeShape } from "../schema";
import { MIME, dropPoint, getPayload } from "../dnd";
import { useEditorStore } from "../store";
import ElementView from "./ElementView";
import ShapeView from "./ShapeView";
import { useBandResize } from "./hooks";

export default function Band({ band, index, total }) {
  const innerRef = useRef(null);
  const zoom = useEditorStore((s) => s.zoom);
  const selected = useEditorStore(
    (s) => s.selected?.kind === "band" && s.selected.bandId === band.id,
  );
  const guides = useEditorStore((s) => s.guides);
  const select = useEditorStore((s) => s.select);
  const moveBand = useEditorStore((s) => s.moveBand);
  const duplicateBand = useEditorStore((s) => s.duplicateBand);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const addElement = useEditorStore((s) => s.addElement);
  const addShape = useEditorStore((s) => s.addShape);

  const height = bandHeight(band);
  const { onPointerDown: onResizeBand } = useBandResize(band.id, height);

  const selectBand = () => select({ kind: "band", bandId: band.id, id: band.id });

  function handleDrop(e) {
    // Tiptap consumes binding drops aimed at text; don't double-handle.
    if (e.defaultPrevented) return;

    const elPayload = getPayload(e, MIME.element);
    const shapePayload = getPayload(e, MIME.shape);
    const bindingPayload = getPayload(e, MIME.binding);
    if (!elPayload && !shapePayload && !bindingPayload) return;

    e.preventDefault();
    e.stopPropagation();
    const pt = dropPoint(e, innerRef.current, zoom);

    if (shapePayload) {
      const shape = makeShape(shapePayload.shape);
      shape.frame.x = Math.max(0, pt.x - shape.frame.w / 2);
      shape.frame.y = Math.max(0, pt.y - shape.frame.h / 2);
      addShape(band.id, shape);
      return;
    }
    if (elPayload) {
      const el = makeElement(elPayload.type);
      el.frame.x = Math.max(0, pt.x - el.frame.w / 2);
      el.frame.y = Math.max(0, pt.y - 12);
      addElement(band.id, el);
      return;
    }
    if (bindingPayload) {
      const el = makeElement(
        "field",
        { x: Math.max(0, pt.x - 110), y: Math.max(0, pt.y - 13) },
        { binding: bindingPayload.key, label: bindingPayload.label },
      );
      addElement(band.id, el);
    }
  }

  return (
    <div className={`band ${band.kind === "repeatable" ? "repeatable" : ""} ${selected ? "selected" : ""}`}>
      <div className="band-chrome">
        <span className="band-name" onClick={selectBand}>
          {band.name}
        </span>
        <span className={`pill ${band.kind === "repeatable" ? "repeat" : "static"}`}>
          {band.kind === "repeatable" ? "REPEATS PER SECTION" : "STATIC"}
        </span>
        <span className="tools">
          <button title="Move up" disabled={index === 0} onClick={() => moveBand(band.id, -1)}>
            ↑
          </button>
          <button
            title="Move down"
            disabled={index === total - 1}
            onClick={() => moveBand(band.id, 1)}
          >
            ↓
          </button>
          <button title="Duplicate" onClick={() => duplicateBand(band.id)}>
            ⧉
          </button>
          <button
            title="Delete section"
            onClick={() => {
              selectBand();
              // selection lands before the click handler returns; defer so
              // deleteSelection reads the fresh selection
              setTimeout(() => deleteSelection(), 0);
            }}
          >
            ✕
          </button>
        </span>
      </div>

      <div
        ref={innerRef}
        className="band-inner"
        style={{ height }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) selectBand();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={handleDrop}
      >
        <div className="layer" style={{ zIndex: 0 }}>
          {band.shapes.map((s) => (
            <ShapeView key={s.id} bandId={band.id} shape={s} />
          ))}
        </div>
        <div className="layer" style={{ zIndex: 1 }}>
          {band.elements.map((el) => (
            <ElementView key={el.id} band={band} el={el} />
          ))}
        </div>
        {guides
          .filter((g) => g.bandId === band.id)
          .map((g, i) =>
            g.axis === "x" ? (
              <div key={i} className="guide x" style={{ left: g.pos, zIndex: 30 }} />
            ) : (
              <div key={i} className="guide y" style={{ top: g.pos, zIndex: 30 }} />
            ),
          )}
        <div className="band-resize" onPointerDown={onResizeBand} title="Drag to resize section" />
      </div>
    </div>
  );
}
