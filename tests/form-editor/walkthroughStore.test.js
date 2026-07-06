import { beforeEach, describe, expect, it } from "vitest";
import { STARTER_TEMPLATE } from "../../shared/walkthroughSchema.js";
import { useWalkthroughStore } from "../../form-editor/src/walkthrough/store.js";

const s = () => useWalkthroughStore.getState();
const sectionById = (id) => s().template.sections.find((x) => x.id === id);

beforeEach(() => {
  s().loadTemplate(structuredClone(STARTER_TEMPLATE), "Walkthrough");
  s().deselect();
});

describe("loadTemplate", () => {
  it("loads a template and clears history/selection", () => {
    expect(s().template.sections).toHaveLength(2);
    expect(s().name).toBe("Walkthrough");
    expect(s().past).toEqual([]);
    expect(s().dirty).toBe(false);
    expect(s().selected).toBeNull();
  });
});

describe("sections", () => {
  it("addSection appends and selects the new section", () => {
    s().addSection("static");
    expect(s().template.sections).toHaveLength(3);
    expect(s().selected.kind).toBe("section");
    expect(s().past.length).toBe(1);
  });

  it("updateSection patches fields", () => {
    s().updateSection("sec_summary", { title: "Overview" });
    expect(sectionById("sec_summary").title).toBe("Overview");
  });

  it("setSectionKind adds an addLabel when switching to repeatable and drops it going back", () => {
    s().setSectionKind("sec_summary", "repeatable");
    expect(sectionById("sec_summary")).toMatchObject({ kind: "repeatable", addLabel: "Add Item" });
    s().setSectionKind("sec_summary", "static");
    expect(sectionById("sec_summary").kind).toBe("static");
    expect(sectionById("sec_summary").addLabel).toBeUndefined();
  });

  it("moveSection reorders", () => {
    s().moveSection("sec_summary", 1);
    expect(s().template.sections.map((x) => x.id)).toEqual(["sec_area", "sec_summary"]);
  });

  it("duplicateSection inserts a copy with a new id and selects it", () => {
    s().duplicateSection("sec_summary");
    expect(s().template.sections).toHaveLength(3);
    expect(s().selected.sectionId).not.toBe("sec_summary");
    expect(s().template.sections[1].id).not.toBe("sec_summary");
  });

  it("removeSection deletes a section", () => {
    s().removeSection("sec_area");
    expect(s().template.sections.map((x) => x.id)).toEqual(["sec_summary"]);
  });
});

describe("fields", () => {
  it("addField appends to a section and selects it", () => {
    const before = sectionById("sec_summary").fields.length;
    s().addField("sec_summary", "toggle");
    expect(sectionById("sec_summary").fields).toHaveLength(before + 1);
    expect(s().selected).toMatchObject({ kind: "field", sectionId: "sec_summary" });
  });

  it("updateField / updateFieldConfig patch a field", () => {
    s().updateField("sec_summary", "f_inspector", { label: "Lead inspector" });
    s().updateFieldConfig("sec_summary", "f_inspector", { variant: "box" });
    const f = sectionById("sec_summary").fields.find((x) => x.id === "f_inspector");
    expect(f.label).toBe("Lead inspector");
    expect(f.config.variant).toBe("box");
  });

  it("duplicateField inserts a copy with a new id", () => {
    const before = sectionById("sec_summary").fields.length;
    s().duplicateField("sec_summary", "f_inspector");
    expect(sectionById("sec_summary").fields).toHaveLength(before + 1);
    expect(s().selected.fieldId).not.toBe("f_inspector");
  });

  it("removeField deletes a field", () => {
    s().removeField("sec_summary", "f_present");
    expect(sectionById("sec_summary").fields.some((f) => f.id === "f_present")).toBe(false);
  });

  it("moveField reorders within a section", () => {
    s().moveField("sec_summary", "f_overview", "sec_summary", 0);
    expect(sectionById("sec_summary").fields[0].id).toBe("f_overview");
  });
});

describe("options (radio/checkbox)", () => {
  it("adds, updates, moves, and removes options", () => {
    s().addOption("sec_area", "f_condition");
    let opts = () => sectionById("sec_area").fields.find((f) => f.id === "f_condition").config.options;
    expect(opts()).toHaveLength(4);
    expect(opts()[3].label).toBe("Option 4");

    s().updateOption("sec_area", "f_condition", "o_good", "Great");
    expect(opts().find((o) => o.id === "o_good").label).toBe("Great");

    s().moveOption("sec_area", "f_condition", "o_fair", -1);
    expect(opts()[0].id).toBe("o_fair");

    s().removeOption("sec_area", "f_condition", "o_poor");
    expect(opts().some((o) => o.id === "o_poor")).toBe(false);
  });
});

describe("history + selection-aware delete", () => {
  it("undo/redo round-trips", () => {
    s().addSection("static");
    s().undo();
    expect(s().template.sections).toHaveLength(2);
    s().redo();
    expect(s().template.sections).toHaveLength(3);
  });

  it("deleteSelection removes a selected field", () => {
    s().select({ kind: "field", sectionId: "sec_summary", fieldId: "f_present" });
    s().deleteSelection();
    expect(sectionById("sec_summary").fields.some((f) => f.id === "f_present")).toBe(false);
    expect(s().selected).toBeNull();
  });

  it("deleteSelection removes an empty section without a confirm prompt", () => {
    s().addSection("static"); // fresh empty section, now selected
    expect(s().template.sections).toHaveLength(3);
    s().deleteSelection();
    expect(s().template.sections).toHaveLength(2);
  });
});
