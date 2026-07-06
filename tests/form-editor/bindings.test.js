import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATE } from "../../shared/walkthroughSchema.js";
import {
  bindingByKey,
  bindingGroups,
  bindingMisplaced,
  photoBindings,
} from "../../form-editor/src/bindings.js";

describe("bindingGroups", () => {
  it("returns just the static relational groups when there is no walkthrough form", () => {
    const groups = bindingGroups(null);
    expect(groups.map((g) => g.id)).toEqual(["client", "property", "report"]);
  });

  it("appends one group per walkthrough section, scoped by section kind", () => {
    const groups = bindingGroups(STARTER_TEMPLATE);
    expect(groups.map((g) => g.id)).toEqual([
      "client",
      "property",
      "report",
      "sec_summary",
      "sec_area",
    ]);
    const summary = groups.find((g) => g.id === "sec_summary");
    const area = groups.find((g) => g.id === "sec_area");
    expect(summary).toMatchObject({ label: "Inspection Summary", scope: "static", sectionId: "sec_summary" });
    expect(summary.fields).toHaveLength(3);
    expect(area).toMatchObject({ scope: "section" });
    expect(area.fields).toHaveLength(5);
  });

  it("skips a section that has no bindable (non-heading) fields", () => {
    const schema = { sections: [{ id: "s", kind: "static", title: "Intro", fields: [{ id: "h", type: "heading", label: "Hi" }] }] };
    expect(bindingGroups(schema).map((g) => g.id)).toEqual(["client", "property", "report"]);
  });
});

describe("bindingByKey", () => {
  it("resolves walkthrough (wt.*) keys against the live schema", () => {
    expect(bindingByKey("wt.f_inspector", STARTER_TEMPLATE).label).toBe("Inspector name");
    expect(bindingByKey("wt.does_not_exist", STARTER_TEMPLATE)).toBeNull();
  });

  it("resolves static relational keys against the fixed catalog", () => {
    expect(bindingByKey("inspection.fullName").source).toBe("Inspections.FullName");
  });

  it("returns null for empty or unknown keys", () => {
    expect(bindingByKey(null)).toBeNull();
    expect(bindingByKey("nope.nope")).toBeNull();
  });
});

describe("photoBindings", () => {
  it("returns only photo-typed walkthrough fields", () => {
    const photos = photoBindings(STARTER_TEMPLATE);
    expect(photos.map((b) => b.key)).toEqual(["wt.f_photos"]);
    expect(photoBindings(null)).toEqual([]);
  });
});

describe("bindingMisplaced", () => {
  const repeatBand = { kind: "repeatable", repeat: { sectionId: "s_rep" } };
  const staticBand = { kind: "static" };

  it("is false for non-section-scope bindings", () => {
    expect(bindingMisplaced({ scope: "static" }, staticBand)).toBe(false);
    expect(bindingMisplaced(null, repeatBand)).toBe(false);
  });

  it("is false when a section binding sits in its matching repeatable band", () => {
    expect(bindingMisplaced({ scope: "section", sectionId: "s_rep" }, repeatBand)).toBe(false);
  });

  it("is true when a section binding sits in a static band", () => {
    expect(bindingMisplaced({ scope: "section", sectionId: "s_rep" }, staticBand)).toBe(true);
  });

  it("is true when a section binding sits in a repeatable band for a different section", () => {
    expect(
      bindingMisplaced({ scope: "section", sectionId: "s_rep" }, { kind: "repeatable", repeat: { sectionId: "other" } }),
    ).toBe(true);
  });
});
