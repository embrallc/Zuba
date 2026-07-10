import { beforeEach, describe, expect, it } from "vitest";
import {
  BAND_W,
  makeBand,
  makeElement,
  makeShape,
  starterTemplate,
} from "../../form-editor/src/schema.js";
import { textMarkActive, useEditorStore } from "../../form-editor/src/store.js";

const s = () => useEditorStore.getState();

beforeEach(() => {
  // Module-singleton store — reset to a known baseline before each test.
  s().loadSchema(starterTemplate(), "Inspection Report");
  s().deselect();
  s().setWalkthroughSchema(null);
});

describe("loadSchema", () => {
  it("sets the schema + name and clears history/dirty", () => {
    expect(s().schema.bands.length).toBe(4);
    expect(s().name).toBe("Inspection Report");
    expect(s().past).toEqual([]);
    expect(s().future).toEqual([]);
    expect(s().dirty).toBe(false);
  });
});

describe("band mutations + history", () => {
  it("addBand appends a band, pushes history, and marks dirty", () => {
    const before = s().schema.bands.length;
    s().addBand("static");
    expect(s().schema.bands.length).toBe(before + 1);
    expect(s().past.length).toBe(1);
    expect(s().dirty).toBe(true);
  });

  it("undo/redo round-trips a mutation", () => {
    const before = s().schema.bands.length;
    s().addBand("static");
    s().undo();
    expect(s().schema.bands.length).toBe(before);
    expect(s().future.length).toBe(1);
    s().redo();
    expect(s().schema.bands.length).toBe(before + 1);
  });

  it("updateBand patches a band", () => {
    const id = s().schema.bands[0].id;
    s().updateBand(id, { name: "Renamed" });
    expect(s().schema.bands[0].name).toBe("Renamed");
  });

  it("removeBand drops a band", () => {
    const id = s().schema.bands[0].id;
    const before = s().schema.bands.length;
    s().removeBand(id);
    expect(s().schema.bands.length).toBe(before - 1);
    expect(s().schema.bands.find((b) => b.id === id)).toBeUndefined();
  });

  it("duplicateBand inserts a copy with a new id right after", () => {
    const id = s().schema.bands[0].id;
    const before = s().schema.bands.length;
    s().duplicateBand(id);
    expect(s().schema.bands.length).toBe(before + 1);
    expect(s().schema.bands[1].id).not.toBe(id);
    expect(s().schema.bands[1].name).toBe(s().schema.bands[0].name);
  });

  it("moveBand reorders", () => {
    const [a, b] = s().schema.bands;
    s().moveBand(a.id, 1);
    expect(s().schema.bands[0].id).toBe(b.id);
    expect(s().schema.bands[1].id).toBe(a.id);
  });

  it("replaceSchema keeps history so it can be undone", () => {
    const before = s().schema;
    s().replaceSchema(starterTemplate());
    expect(s().past.length).toBe(1);
    s().undo();
    expect(s().schema).toEqual(before);
  });
});

describe("element mutations", () => {
  it("addElement pushes an element and selects it", () => {
    const bandId = s().schema.bands[0].id;
    const el = makeElement("field", {}, { binding: "inspection.city" });
    s().addElement(bandId, el);
    const band = s().schema.bands.find((b) => b.id === bandId);
    expect(band.elements.some((e) => e.id === el.id)).toBe(true);
    expect(s().selected).toEqual({ kind: "element", bandId, id: el.id });
  });

  it("updateNode clamps an over-wide frame to the band width", () => {
    const bandId = s().schema.bands[0].id;
    const el = makeElement("field", {}, { binding: "x" });
    s().addElement(bandId, el);
    s().updateNode({ kind: "element", bandId, id: el.id }, { frame: { w: 99999 } });
    const band = s().schema.bands.find((b) => b.id === bandId);
    expect(band.elements.find((e) => e.id === el.id).frame.w).toBe(BAND_W);
  });

  it("removeNode deletes the selected element", () => {
    const bandId = s().schema.bands[0].id;
    const el = makeElement("field", {}, { binding: "x" });
    s().addElement(bandId, el);
    s().removeNode({ kind: "element", bandId, id: el.id });
    const band = s().schema.bands.find((b) => b.id === bandId);
    expect(band.elements.some((e) => e.id === el.id)).toBe(false);
  });

  it("duplicateNode offsets the copy by 16px", () => {
    const bandId = s().schema.bands[0].id;
    const el = makeElement("field", { x: 10, y: 10 }, { binding: "x" });
    s().addElement(bandId, el);
    s().duplicateNode({ kind: "element", bandId, id: el.id });
    const band = s().schema.bands.find((b) => b.id === bandId);
    const copy = band.elements[band.elements.length - 1];
    expect(copy.id).not.toBe(el.id);
    expect(copy.frame.x).toBe(26);
    expect(copy.frame.y).toBe(26);
  });
});

describe("misc setters + selectors", () => {
  it("select/deselect track the selection", () => {
    s().select({ kind: "band", bandId: "b1" });
    expect(s().selected).toEqual({ kind: "band", bandId: "b1" });
    s().deselect();
    expect(s().selected).toBeNull();
  });

  it("setName / setZoom / setWalkthroughSchema / setSaveState update state", () => {
    s().setName("My Report");
    s().setZoom(1.5);
    s().setWalkthroughSchema({ sections: [] });
    s().setSaveState("saved");
    expect(s().name).toBe("My Report");
    expect(s().zoom).toBe(1.5);
    expect(s().walkthroughSchema).toEqual({ sections: [] });
    expect(s().saveState).toBe("saved");
  });

  it("bandHeights reports a height per band", () => {
    const heights = s().bandHeights();
    expect(heights).toHaveLength(s().schema.bands.length);
    for (const h of heights) {
      expect(typeof h.id).toBe("string");
      expect(typeof h.h).toBe("number");
    }
  });
});

describe("grouping + multi-select", () => {
  const band0 = () => s().schema.bands[0];

  // Build a one-band schema with text elements at the given frames.
  function setup(frames) {
    const band = makeBand("static", "T");
    const els = frames.map((f) => {
      const el = makeElement("text", f);
      band.elements.push(el);
      return el;
    });
    s().loadSchema({ version: 1, bands: [band] }, "T");
    s().deselect();
    return { bandId: band.id, ids: els.map((e) => e.id) };
  }

  it("toggleSelect builds a multi-selection and collapses back to single", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    expect(s().selected).toEqual({ kind: "element", bandId, id: ids[0] });
    expect(s().selectedIds).toEqual([]);
    s().toggleSelect({ bandId, id: ids[1] });
    expect(s().selected).toBe(null);
    expect(s().selectedIds).toEqual([ids[0], ids[1]]);
    s().toggleSelect({ bandId, id: ids[0] }); // toggle one off
    expect(s().selected).toEqual({ kind: "element", bandId, id: ids[1] });
    expect(s().selectedIds).toEqual([]);
  });

  it("groupSelection creates a group of the selection and selects it", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    expect(band0().groups).toHaveLength(1);
    expect(band0().groups[0].memberIds).toEqual(ids);
    expect(s().selected).toEqual({ kind: "group", bandId, id: band0().groups[0].id });
    expect(s().selectedIds).toEqual([]);
  });

  it("clicking a grouped child selects the whole group", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    const gid = band0().groups[0].id;
    s().selectResolved({ bandId, id: ids[0] });
    expect(s().selected).toEqual({ kind: "group", bandId, id: gid });
  });

  it("ungroupSelection dissolves the group and promotes its members", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    s().ungroupSelection();
    expect(band0().groups).toHaveLength(0);
    expect(s().selectedIds).toEqual(ids);
  });

  it("align left equalizes the left edges of top-level objects", () => {
    const { bandId, ids } = setup([{ x: 10, y: 0, w: 50 }, { x: 200, y: 40, w: 80 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().alignSelection("left");
    const els = band0().elements;
    expect(els[0].frame.x).toBe(10);
    expect(els[1].frame.x).toBe(10);
  });

  it("setGap spaces objects to an exact horizontal gap (first fixed)", () => {
    const { bandId, ids } = setup([
      { x: 0, y: 0, w: 40 },
      { x: 500, y: 0, w: 40 },
      { x: 100, y: 0, w: 40 },
    ]);
    ids.forEach((id) => s().toggleSelect({ bandId, id }));
    s().setGapSelection("h", 10);
    const byId = Object.fromEntries(band0().elements.map((e) => [e.id, e.frame]));
    expect(byId[ids[0]].x).toBe(0); // sorted first, fixed
    expect(byId[ids[2]].x).toBe(50); // 0 + 40 + 10
    expect(byId[ids[1]].x).toBe(100); // 50 + 40 + 10
  });

  it("resizeSelection sets a uniform width/height across bare objects", () => {
    const { bandId, ids } = setup([
      { x: 0, y: 0, w: 50, h: 20 },
      { x: 100, y: 0, w: 80, h: 40 },
    ]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().resizeSelection("w", 120);
    s().resizeSelection("h", 30);
    for (const el of band0().elements) {
      expect(el.frame.w).toBe(120);
      expect(el.frame.h).toBe(30);
    }
  });

  it("resizeSelection skips groups (only bare nodes change)", () => {
    const { bandId, ids } = setup([
      { x: 0, y: 0, w: 40, h: 20 },
      { x: 60, y: 0, w: 40, h: 20 },
      { x: 300, y: 0, w: 90, h: 50 },
    ]);
    // group the first two, leave the third bare
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    const gid = s().selected.id;
    s().deselect();
    s().toggleSelect({ bandId, id: gid });
    s().toggleSelect({ bandId, id: ids[2] });
    s().resizeSelection("w", 70);
    const byId = Object.fromEntries(band0().elements.map((e) => [e.id, e.frame]));
    expect(byId[ids[0]].w).toBe(40); // inside a group — untouched
    expect(byId[ids[1]].w).toBe(40);
    expect(byId[ids[2]].w).toBe(70); // bare — resized
  });

  it("moving a group translates all its leaves rigidly", () => {
    const { bandId, ids } = setup([{ x: 10, y: 10 }, { x: 100, y: 10 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    s().nudgeSelection(5, 7);
    const [a, b] = band0().elements;
    expect([a.frame.x, a.frame.y]).toEqual([15, 17]);
    expect([b.frame.x, b.frame.y]).toEqual([105, 17]);
  });

  it("nested: aligning two groups moves the groups, not their internals", () => {
    const { bandId, ids } = setup([
      { x: 0, y: 0, w: 40 },
      { x: 50, y: 0, w: 40 },
      { x: 300, y: 100, w: 40 },
      { x: 350, y: 100, w: 40 },
    ]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    const g1 = s().selected.id;
    s().deselect();
    s().toggleSelect({ bandId, id: ids[2] });
    s().toggleSelect({ bandId, id: ids[3] });
    s().groupSelection();
    const g2 = s().selected.id;

    s().deselect();
    s().toggleSelect({ bandId, id: g1 });
    s().toggleSelect({ bandId, id: g2 });
    expect([...s().selectedIds].sort()).toEqual([g1, g2].sort());
    s().alignSelection("left");

    const byId = Object.fromEntries(band0().elements.map((e) => [e.id, e.frame]));
    expect(byId[ids[0]].x).toBe(0); // g1 already at 0
    expect(byId[ids[1]].x).toBe(50); // internal offset preserved
    expect(byId[ids[2]].x).toBe(0); // g2 moved 300 -> 0
    expect(byId[ids[3]].x).toBe(50); // internal offset preserved (350 -> 50)
  });

  it("duplicating a group clones leaves + remaps memberIds (no stale refs)", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    const gid = s().selected.id;
    s().duplicateNode({ kind: "group", bandId, id: gid });
    const band = band0();
    expect(band.groups).toHaveLength(2);
    expect(band.elements).toHaveLength(4);
    const newG = band.groups.find((g) => g.id !== gid);
    for (const m of newG.memberIds) {
      expect(ids).not.toContain(m); // remapped to the clones
      expect(band.elements.some((e) => e.id === m)).toBe(true);
    }
  });

  it("duplicating a group preserves shape z-order, not member order", () => {
    // rect BEHIND line in paint order (array order), but selected line-first.
    const band = makeBand("static", "T");
    const rect = makeShape("rect", { x: 0, y: 0 });
    const line = makeShape("line", { x: 0, y: 10 });
    band.shapes.push(rect, line);
    s().loadSchema({ version: 1, bands: [band] }, "T");
    s().deselect();
    const bandId = band.id;
    s().toggleSelect({ bandId, id: line.id }); // select in reverse of z-order
    s().toggleSelect({ bandId, id: rect.id });
    s().groupSelection();
    const gid = s().selected.id;
    s().duplicateNode({ kind: "group", bandId, id: gid });
    const shapes = s().schema.bands[0].shapes;
    expect(shapes).toHaveLength(4);
    const origIds = new Set([rect.id, line.id]);
    const clones = shapes.filter((sh) => !origIds.has(sh.id));
    // Clones keep original paint order (rect first, line second), so the filled
    // rect doesn't cover the line.
    expect(clones.map((c) => c.shape)).toEqual(["rect", "line"]);
  });

  it("deleting a group removes its leaves and the group entry", () => {
    const { bandId, ids } = setup([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    s().deleteSelection();
    expect(band0().elements).toHaveLength(0);
    expect(band0().groups).toHaveLength(0);
  });

  it("a legacy band with no `groups` field still groups on demand", () => {
    const band = makeBand("static", "Legacy");
    delete band.groups; // simulate a template saved before grouping existed
    band.elements.push(
      makeElement("text", { x: 0, y: 0 }),
      makeElement("text", { x: 80, y: 0 }),
    );
    s().loadSchema({ version: 1, bands: [band] }, "Legacy");
    s().deselect();
    const bandId = band0().id;
    const ids = band0().elements.map((e) => e.id);
    s().toggleSelect({ bandId, id: ids[0] });
    s().toggleSelect({ bandId, id: ids[1] });
    s().groupSelection();
    expect(band0().groups).toHaveLength(1);
  });
});

describe("text formatting", () => {
  const band0 = () => s().schema.bands[0];

  it("toggleTextMark bolds the whole text box and toggles it back off", () => {
    const band = makeBand("static", "T");
    const el = makeElement("text", { x: 0, y: 0 }, { text: "Hello world" });
    band.elements.push(el);
    s().loadSchema({ version: 1, bands: [band] }, "T");
    const sel = { kind: "element", bandId: band.id, id: el.id };
    s().toggleTextMark(sel, "bold");
    expect(textMarkActive(band0().elements[0], "bold")).toBe(true);
    s().toggleTextMark(sel, "bold");
    expect(textMarkActive(band0().elements[0], "bold")).toBe(false);
  });

  it("applySharedBold bolds text via marks and fields via style", () => {
    const band = makeBand("static", "T");
    const t = makeElement("text", { x: 0, y: 0 }, { text: "Label" });
    const f = makeElement("field", { x: 0, y: 40 }, { label: "Field" });
    band.elements.push(t, f);
    s().loadSchema({ version: 1, bands: [band] }, "T");
    s().deselect();
    const bandId = band.id;
    s().toggleSelect({ bandId, id: t.id });
    s().toggleSelect({ bandId, id: f.id });
    s().applySharedBold(true);
    const els = band0().elements;
    expect(textMarkActive(els.find((e) => e.id === t.id), "bold")).toBe(true);
    expect(els.find((e) => e.id === f.id).style.bold).toBe(true);
  });
});
