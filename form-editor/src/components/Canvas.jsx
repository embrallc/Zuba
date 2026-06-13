import { useRef, useState } from "react";
import { MIME, getPayload, hasType } from "../dnd";
import { PAGE, PAGE_CONTENT_H, bandHeight } from "../schema";
import { useEditorStore } from "../store";
import Band from "./Band";
import TextToolbar from "./TextToolbar";

export default function Canvas() {
  const schema = useEditorStore((s) => s.schema);
  const zoom = useEditorStore((s) => s.zoom);
  const saveState = useEditorStore((s) => s.saveState);
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const deselect = useEditorStore((s) => s.deselect);
  const addBand = useEditorStore((s) => s.addBand);
  const bandsRef = useRef(null);
  const [dropIdx, setDropIdx] = useState(null);

  if (!schema) return null;

  // Approximate page boundaries. Repeatable bands expand per report, so the
  // real count comes from the generator — these guides just keep designs
  // page-aware.
  const BAND_GAP = 14;
  const totalH = schema.bands.reduce((acc, b) => acc + bandHeight(b) + BAND_GAP, 0);
  const pageCount = Math.max(1, Math.ceil(totalH / PAGE_CONTENT_H));
  const breaks = Array.from({ length: pageCount - 1 }, (_, i) => (i + 1) * PAGE_CONTENT_H);

  function gapIndexFromPointer(e) {
    const slots = bandsRef.current?.querySelectorAll(":scope > .band-slot");
    if (!slots?.length) return 0;
    let idx = slots.length;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    return idx;
  }

  return (
    <div
      className="canvas-wrap"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) deselect();
      }}
    >
      {saveState === "conflict" && (
        <div className="banner">
          This template was changed somewhere else (another tab or device).
          <button className="btn" onClick={() => location.reload()}>
            Reload latest
          </button>
        </div>
      )}
      {saveState === "local" && (
        <div className="banner info">
          Local preview — changes save to this browser only.
        </div>
      )}
      {editingTextId && <TextToolbar />}

      <div
        className="sheet-scale"
        style={{ transform: `scale(${zoom})`, width: PAGE.widthPx }}
      >
        <div
          className="sheet"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) deselect();
          }}
        >
          {breaks.map((y, i) => (
            <div key={i} className="page-break" style={{ top: PAGE.marginPx + y }}>
              <span>Page {i + 2}</span>
            </div>
          ))}

          <div
            className="bands"
            ref={bandsRef}
            onDragOver={(e) => {
              if (!hasType(e, MIME.band)) return;
              e.preventDefault();
              setDropIdx(gapIndexFromPointer(e));
            }}
            onDragLeave={(e) => {
              if (!bandsRef.current?.contains(e.relatedTarget)) setDropIdx(null);
            }}
            onDrop={(e) => {
              const payload = getPayload(e, MIME.band);
              setDropIdx(null);
              if (!payload) return;
              e.preventDefault();
              addBand(payload.bandKind, gapIndexFromPointer(e));
            }}
          >
            {schema.bands.map((band, i) => (
              <div className="band-slot" key={band.id}>
                {dropIdx === i && <div className="drop-indicator" />}
                <Band band={band} index={i} total={schema.bands.length} />
              </div>
            ))}
            {dropIdx === schema.bands.length && <div className="drop-indicator" />}
          </div>
        </div>
      </div>
    </div>
  );
}
