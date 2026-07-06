import { beforeEach, describe, expect, it } from "vitest";
import { BAND_W, makeElement, starterTemplate } from "../../form-editor/src/schema.js";
import { useEditorStore } from "../../form-editor/src/store.js";

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
