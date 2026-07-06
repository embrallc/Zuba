import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATE } from "../../shared/walkthroughSchema.js";
import {
  BAND_W,
  PAGE,
  repeatableSections,
  walkthroughBindingByKey,
  walkthroughFieldBindings,
  walkthroughToReport,
} from "../../shared/walkthroughToReport.js";

// A compact schema with one static + one repeatable section, plus a heading
// (which must be skipped as a binding) and each interesting field type.
const SCHEMA = {
  version: 1,
  sections: [
    {
      id: "s_static",
      kind: "static",
      title: "Summary",
      fields: [
        { id: "h1", type: "heading", label: "About" },
        { id: "f_name", type: "text", label: "Inspector", config: { variant: "line" } },
        { id: "f_notes", type: "text", label: "Overview", config: { variant: "multiline" } },
      ],
    },
    {
      id: "s_rep",
      kind: "repeatable",
      title: "Area",
      fields: [
        { id: "f_sev", type: "severity", label: "Severity" },
        { id: "f_pic", type: "photo", label: "Photos" },
        {
          id: "f_choice",
          type: "radio",
          label: "Condition",
          config: { options: [{ id: "o1", label: "Good" }] },
        },
      ],
    },
  ],
};

describe("page geometry", () => {
  it("is US letter with a 720px content band", () => {
    expect(PAGE).toMatchObject({ size: "letter", widthPx: 816, heightPx: 1056, marginPx: 48 });
    expect(BAND_W).toBe(720);
  });
});

describe("walkthroughFieldBindings", () => {
  it("emits one wt.<id> binding per non-heading field", () => {
    const bindings = walkthroughFieldBindings(SCHEMA);
    // 2 static (name, notes) + 3 repeatable (sev, pic, choice) = 5; heading skipped.
    expect(bindings.map((b) => b.key)).toEqual([
      "wt.f_name",
      "wt.f_notes",
      "wt.f_sev",
      "wt.f_pic",
      "wt.f_choice",
    ]);
  });

  it("scopes static-section fields 'static' and repeatable-section fields 'section'", () => {
    const byKey = Object.fromEntries(walkthroughFieldBindings(SCHEMA).map((b) => [b.key, b]));
    expect(byKey["wt.f_name"].scope).toBe("static");
    expect(byKey["wt.f_sev"].scope).toBe("section");
  });

  it("maps photo fields to image type and carries options + section metadata", () => {
    const byKey = Object.fromEntries(walkthroughFieldBindings(SCHEMA).map((b) => [b.key, b]));
    expect(byKey["wt.f_pic"]).toMatchObject({ fieldType: "photo", type: "image" });
    expect(byKey["wt.f_name"].type).toBe("text");
    expect(byKey["wt.f_choice"].options).toEqual([{ id: "o1", label: "Good" }]);
    expect(byKey["wt.f_sev"]).toMatchObject({ sectionId: "s_rep", sectionTitle: "Area", sectionKind: "repeatable" });
  });

  it("returns [] for null/empty schemas", () => {
    expect(walkthroughFieldBindings(null)).toEqual([]);
    expect(walkthroughFieldBindings({ sections: [] })).toEqual([]);
  });
});

describe("walkthroughBindingByKey", () => {
  it("finds a binding by key, else null", () => {
    expect(walkthroughBindingByKey(SCHEMA, "wt.f_name").label).toBe("Inspector");
    expect(walkthroughBindingByKey(SCHEMA, "wt.missing")).toBeNull();
    expect(walkthroughBindingByKey(SCHEMA, null)).toBeNull();
  });
});

describe("repeatableSections", () => {
  it("returns only repeatable sections", () => {
    expect(repeatableSections(SCHEMA).map((s) => s.id)).toEqual(["s_rep"]);
    expect(repeatableSections(null)).toEqual([]);
  });
});

describe("walkthroughToReport", () => {
  it("always emits a header + client/property band, then one band per section", () => {
    const report = walkthroughToReport(SCHEMA);
    expect(report.version).toBe(1);
    expect(report.page).toBe(PAGE);
    expect(report.bands.map((b) => b.name)).toEqual([
      "Report Header",
      "Client & Property",
      "Summary",
      "Area",
    ]);
  });

  it("emits only the two fixed bands for an empty/null schema", () => {
    expect(walkthroughToReport(null).bands.map((b) => b.name)).toEqual([
      "Report Header",
      "Client & Property",
    ]);
    expect(walkthroughToReport({ sections: [] }).bands).toHaveLength(2);
  });

  it("makes the repeatable section a repeatable band bound to its sectionId", () => {
    const report = walkthroughToReport(SCHEMA);
    const area = report.bands.find((b) => b.name === "Area");
    const summary = report.bands.find((b) => b.name === "Summary");
    expect(area.kind).toBe("repeatable");
    expect(area.repeat).toEqual({ sectionId: "s_rep" });
    expect(summary.kind).toBe("static");
    expect(summary.repeat).toBeNull();
  });

  it("binds the client band to the relational inspection fields", () => {
    const report = walkthroughToReport(SCHEMA);
    const cp = report.bands.find((b) => b.name === "Client & Property");
    const bindings = cp.elements.filter((e) => e.type === "field").map((e) => e.binding);
    expect(bindings).toEqual(
      expect.arrayContaining([
        "inspection.fullName",
        "inspection.phone",
        "inspection.email",
        "inspection.addressLine1",
        "inspection.city",
        "inspection.state",
        "inspection.zipCode",
      ]),
    );
  });

  it("lays out a multiline text field as a taller box, a line field as a plain row", () => {
    const report = walkthroughToReport(SCHEMA);
    const summary = report.bands.find((b) => b.name === "Summary");
    const notes = summary.elements.find((e) => e.binding === "wt.f_notes");
    const name = summary.elements.find((e) => e.binding === "wt.f_name");
    expect(notes.style.variant).toBe("box");
    expect(notes.frame.h).toBe(52);
    expect(name.style.variant).toBe("plain");
    expect(name.frame.h).toBe(24);
  });

  it("renders a photo field as a photoGrid element", () => {
    const report = walkthroughToReport(SCHEMA);
    const area = report.bands.find((b) => b.name === "Area");
    const grid = area.elements.find((e) => e.binding === "wt.f_pic");
    expect(grid.type).toBe("photoGrid");
  });

  it("centers severity values", () => {
    const report = walkthroughToReport(SCHEMA);
    const area = report.bands.find((b) => b.name === "Area");
    const sev = area.elements.find((e) => e.binding === "wt.f_sev");
    expect(sev.style.align).toBe("center");
    expect(sev.style.variant).toBe("box");
  });

  it("gives every band + node a unique id and the required shape", () => {
    const report = walkthroughToReport(STARTER_TEMPLATE);
    const ids = [];
    for (const b of report.bands) {
      expect(b).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          kind: expect.any(String),
          shapes: expect.any(Array),
          elements: expect.any(Array),
          minHeightPx: expect.any(Number),
        }),
      );
      ids.push(b.id, ...b.elements.map((e) => e.id), ...b.shapes.map((s) => s.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
