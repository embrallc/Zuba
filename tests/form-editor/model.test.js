import { describe, expect, it } from "vitest";
import {
  DND_MOVE_FIELD,
  DND_NEW_FIELD,
  PALETTE_FIELDS,
  cloneFieldWithNewIds,
  cloneSectionWithNewIds,
  emptyTemplate,
  makeField,
  makeId,
  makeOption,
  makeSection,
} from "../../form-editor/src/walkthrough/model.js";

describe("makeId", () => {
  it("prefixes and appends a uuid", () => {
    expect(makeId("f")).toMatch(/^f_[0-9a-f-]{36}$/i);
    expect(makeId()).toMatch(/^id_/);
    expect(makeId("f")).not.toBe(makeId("f"));
  });
});

describe("makeOption", () => {
  it("builds an option with an id and label", () => {
    expect(makeOption("Good")).toMatchObject({ label: "Good" });
    expect(makeOption("Good").id).toMatch(/^o_/);
    expect(makeOption().label).toBe("Option");
  });
});

describe("makeField", () => {
  it("applies per-type defaults", () => {
    expect(makeField("text")).toMatchObject({ type: "text", label: "Question or label", config: { variant: "line" } });
    expect(makeField("toggle")).toMatchObject({ label: "Yes / no question?", config: {} });
    expect(makeField("photo").config).toEqual({ notes: true });
    expect(makeField("heading").label).toBe("Section heading");
    expect(makeField("severity").label).toBe("Severity");
  });

  it("seeds radio/checkbox with two options that carry ids", () => {
    const radio = makeField("radio");
    expect(radio.config.options).toHaveLength(2);
    expect(radio.config.options.map((o) => o.label)).toEqual(["Option 1", "Option 2"]);
    for (const o of radio.config.options) expect(o.id).toMatch(/^o_/);
    expect(makeField("checkbox").config.options).toHaveLength(2);
  });

  it("falls back to a generic field for an unknown type", () => {
    expect(makeField("mystery")).toMatchObject({ type: "mystery", label: "Field", config: {} });
  });

  it("gives every field a fresh id", () => {
    expect(makeField("text").id).not.toBe(makeField("text").id);
  });
});

describe("makeSection", () => {
  it("builds a static section by default (no addLabel)", () => {
    const s = makeSection();
    expect(s).toMatchObject({ kind: "static", title: "New Section", fields: [] });
    expect(s.addLabel).toBeUndefined();
  });

  it("builds a repeatable section with an add label", () => {
    expect(makeSection("repeatable")).toMatchObject({
      kind: "repeatable",
      title: "New Repeating Section",
      addLabel: "Add Item",
    });
  });
});

describe("cloneFieldWithNewIds", () => {
  it("reassigns the field id and every option id, preserving labels", () => {
    const field = makeField("radio");
    const copy = cloneFieldWithNewIds(field);
    expect(copy.id).not.toBe(field.id);
    expect(copy.config.options[0].id).not.toBe(field.config.options[0].id);
    expect(copy.config.options.map((o) => o.label)).toEqual(field.config.options.map((o) => o.label));
  });
});

describe("cloneSectionWithNewIds", () => {
  it("reassigns the section id and clones each field with new ids", () => {
    const sec = makeSection("static");
    sec.fields.push(makeField("text"), makeField("radio"));
    const copy = cloneSectionWithNewIds(sec);
    expect(copy.id).not.toBe(sec.id);
    expect(copy.fields).toHaveLength(2);
    expect(copy.fields[0].id).not.toBe(sec.fields[0].id);
    expect(copy.fields[1].config.options[0].id).not.toBe(sec.fields[1].config.options[0].id);
  });
});

describe("emptyTemplate", () => {
  it("is a versioned template with no sections", () => {
    expect(emptyTemplate()).toEqual({ version: 1, sections: [] });
  });
});

describe("PALETTE_FIELDS + DnD mime keys", () => {
  it("lists the seven field types with glyph + label", () => {
    expect(PALETTE_FIELDS.map((f) => f.type)).toEqual([
      "heading",
      "text",
      "toggle",
      "radio",
      "checkbox",
      "photo",
      "severity",
    ]);
    for (const f of PALETTE_FIELDS) {
      expect(typeof f.glyph).toBe("string");
      expect(typeof f.label).toBe("string");
    }
  });

  it("exposes distinct drag mime types", () => {
    expect(DND_NEW_FIELD).toBeTruthy();
    expect(DND_MOVE_FIELD).toBeTruthy();
    expect(DND_NEW_FIELD).not.toBe(DND_MOVE_FIELD);
  });
});
