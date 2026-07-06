import { describe, expect, it } from "vitest";
import {
  BAND_W,
  GRID,
  PAGE,
  PAGE_CONTENT_H,
  bandHeight,
  clampFrame,
  cloneWithNewIds,
  makeBand,
  makeElement,
  makeShape,
  snap,
  starterTemplate,
} from "../../form-editor/src/schema.js";

describe("page constants", () => {
  it("derives the content band + page height from letter size", () => {
    expect(PAGE).toMatchObject({ widthPx: 816, heightPx: 1056, marginPx: 48 });
    expect(BAND_W).toBe(720);
    expect(PAGE_CONTENT_H).toBe(960);
    expect(GRID).toBe(4);
  });
});

describe("makeBand", () => {
  it("builds a static band by default", () => {
    const b = makeBand("static");
    expect(b).toMatchObject({ kind: "static", name: "Section", repeat: null, minHeightPx: 140 });
    expect(b.shapes).toEqual([]);
    expect(b.elements).toEqual([]);
    expect(typeof b.id).toBe("string");
  });

  it("builds a repeatable band bound to the sections collection", () => {
    const b = makeBand("repeatable");
    expect(b.name).toBe("Repeating Section");
    expect(b.repeat).toEqual({ collection: "sections" });
  });

  it("honors a custom name", () => {
    expect(makeBand("static", "Header").name).toBe("Header");
  });
});

describe("makeShape", () => {
  it("defaults per shape kind", () => {
    expect(makeShape("rect").frame).toEqual({ x: 16, y: 16, w: 200, h: 120 });
    expect(makeShape("ellipse").frame).toEqual({ x: 16, y: 16, w: 120, h: 120 });
    expect(makeShape("line").frame).toEqual({ x: 0, y: 24, w: 240, h: 12 });
  });

  it("styles lines with a stroke and fills otherwise", () => {
    expect(makeShape("line").style).toMatchObject({ fill: "transparent", stroke: "#111827", strokeWidth: 2 });
    expect(makeShape("rect").style).toMatchObject({ fill: "#EEF0FF", stroke: "transparent" });
  });

  it("merges a frame override", () => {
    expect(makeShape("rect", { x: 5, w: 50 }).frame).toEqual({ x: 5, y: 16, w: 50, h: 120 });
  });
});

describe("makeElement", () => {
  it("builds a text element with a tiptap doc", () => {
    const el = makeElement("text", {}, { text: "Hi" });
    expect(el.type).toBe("text");
    expect(el.content.content[0].content[0].text).toBe("Hi");
    expect(el.style).toMatchObject({ fontSize: 14, align: "left" });
  });

  it("builds a field element carrying a binding + label", () => {
    const el = makeElement("field", {}, { binding: "inspection.city", label: "City" });
    expect(el).toMatchObject({ type: "field", binding: "inspection.city", label: "City" });
    expect(el.style.variant).toBe("underline");
  });

  it("builds divider / photoGrid / image elements", () => {
    expect(makeElement("divider").frame.w).toBe(BAND_W);
    expect(makeElement("divider").style).toMatchObject({ thickness: 2 });
    expect(makeElement("photoGrid").style).toMatchObject({ cols: 3, gap: 12, captions: true });
    expect(makeElement("image").asset).toBeNull();
  });

  it("throws on an unknown element type", () => {
    expect(() => makeElement("bogus")).toThrow(/Unknown element type/);
  });
});

describe("cloneWithNewIds", () => {
  it("deep-clones and reassigns every nested id", () => {
    const band = makeBand("static");
    band.elements.push(makeElement("field", {}, { binding: "x" }));
    const copy = cloneWithNewIds(band);
    expect(copy.id).not.toBe(band.id);
    expect(copy.elements[0].id).not.toBe(band.elements[0].id);
    // Non-id content is preserved.
    expect(copy.elements[0].binding).toBe("x");
    expect(copy.kind).toBe(band.kind);
  });
});

describe("starterTemplate", () => {
  it("seeds a four-band example report", () => {
    const t = starterTemplate();
    expect(t.version).toBe(1);
    expect(t.page).toBe(PAGE);
    expect(t.bands.map((b) => b.name)).toEqual([
      "Report Header",
      "Client & Property",
      "Walkthrough Section",
      "Summary",
    ]);
    expect(t.bands.find((b) => b.name === "Walkthrough Section").kind).toBe("repeatable");
  });
});

describe("bandHeight", () => {
  it("grows to fit content past the minimum", () => {
    const b = makeBand("static"); // minHeightPx 140
    b.elements.push(makeElement("text", { x: 0, y: 0, w: 100, h: 200 }));
    expect(bandHeight(b)).toBe(216); // 200 + 16 padding
  });

  it("falls back to the minimum for short content", () => {
    const b = makeBand("static");
    b.elements.push(makeElement("text", { x: 0, y: 0, w: 100, h: 10 }));
    expect(bandHeight(b)).toBe(140);
  });
});

describe("snap", () => {
  it("rounds to the 4px grid, or to whole px when disabled", () => {
    expect(snap(7)).toBe(8);
    expect(snap(9)).toBe(8);
    expect(snap(10)).toBe(12);
    expect(snap(7, true)).toBe(7);
    expect(snap(0)).toBe(0);
  });
});

describe("clampFrame", () => {
  it("clamps width, height, and keeps the frame inside the band", () => {
    expect(clampFrame({ x: -5, y: -5, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 16, h: 10 });
  });

  it("clamps an oversized frame to the band width and pins x to 0", () => {
    expect(clampFrame({ x: 1000, y: 5, w: 1000, h: 50 })).toEqual({ x: 0, y: 5, w: 720, h: 50 });
  });
});
