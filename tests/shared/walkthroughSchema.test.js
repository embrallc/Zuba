import { describe, expect, it } from "vitest";
import {
  FIELD_TYPES,
  SCHEMA_VERSION,
  SECTION_KINDS,
  SEVERITY_LEVELS,
  STARTER_TEMPLATE,
  TEXT_VARIANTS,
  emptyAnswers,
  fieldHasAnswer,
  makeInstance,
} from "../../shared/walkthroughSchema.js";

describe("walkthroughSchema — contract constants", () => {
  it("pins the schema version + section kinds", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(SECTION_KINDS).toEqual(["static", "repeatable"]);
  });

  it("declares the seven field types with hasAnswer flags", () => {
    expect(Object.keys(FIELD_TYPES)).toEqual([
      "heading",
      "text",
      "toggle",
      "radio",
      "checkbox",
      "photo",
      "severity",
    ]);
    // Only headings are display-only.
    expect(FIELD_TYPES.heading.hasAnswer).toBe(false);
    for (const t of ["text", "toggle", "radio", "checkbox", "photo", "severity"]) {
      expect(FIELD_TYPES[t].hasAnswer).toBe(true);
      expect(typeof FIELD_TYPES[t].label).toBe("string");
    }
  });

  it("pins the text variants", () => {
    expect(TEXT_VARIANTS).toEqual(["line", "box", "multiline"]);
  });

  it("pins the severity scale keys + exact colors (report generator depends on these)", () => {
    expect(SEVERITY_LEVELS.map((s) => s.key)).toEqual(["ok", "low", "medium", "critical"]);
    const byKey = Object.fromEntries(SEVERITY_LEVELS.map((s) => [s.key, s]));
    expect(byKey.ok.color).toBe("#16A34A");
    expect(byKey.low.color).toBe("#CA8A04");
    expect(byKey.medium.color).toBe("#EA580C");
    expect(byKey.critical.color).toBe("#DC2626");
    for (const s of SEVERITY_LEVELS) {
      expect(s).toHaveProperty("label");
      expect(s).toHaveProperty("bg");
    }
  });
});

describe("fieldHasAnswer", () => {
  it("is true for value types, false for headings + unknowns", () => {
    expect(fieldHasAnswer("text")).toBe(true);
    expect(fieldHasAnswer("photo")).toBe(true);
    expect(fieldHasAnswer("heading")).toBe(false);
    expect(fieldHasAnswer("not-a-type")).toBe(false);
    expect(fieldHasAnswer(undefined)).toBe(false);
  });
});

describe("emptyAnswers", () => {
  const idgen = () => {
    idgen.n = (idgen.n ?? 0) + 1;
    return `inst_${idgen.n}`;
  };

  it("seeds static sections with one instance and repeatable sections with none", () => {
    const answers = emptyAnswers(STARTER_TEMPLATE, () => "inst");
    expect(Object.keys(answers.sections)).toEqual(["sec_summary", "sec_area"]);
    expect(answers.sections.sec_summary.instances).toHaveLength(1);
    expect(answers.sections.sec_summary.instances[0].fields).toEqual({});
    expect(answers.sections.sec_area.instances).toHaveLength(0);
  });

  it("uses the injected id generator for static instances", () => {
    const answers = emptyAnswers({ sections: [{ id: "s1", kind: "static", fields: [] }] }, idgen);
    expect(answers.sections.s1.instances[0].instanceId).toMatch(/^inst_\d+$/);
  });

  it("returns an empty sections map for a null/empty schema", () => {
    expect(emptyAnswers(null, () => "x")).toEqual({ sections: {} });
    expect(emptyAnswers({ sections: [] }, () => "x")).toEqual({ sections: {} });
  });
});

describe("makeInstance", () => {
  it("builds a blank instance with the injected id", () => {
    expect(makeInstance(() => "abc")).toEqual({ instanceId: "abc", fields: {} });
  });
});

describe("STARTER_TEMPLATE", () => {
  it("is a valid two-section starter (summary + repeatable area)", () => {
    expect(STARTER_TEMPLATE.version).toBe(SCHEMA_VERSION);
    expect(STARTER_TEMPLATE.sections.map((s) => s.id)).toEqual(["sec_summary", "sec_area"]);
    const [summary, area] = STARTER_TEMPLATE.sections;
    expect(summary.kind).toBe("static");
    expect(area.kind).toBe("repeatable");
    expect(area.addLabel).toBe("Add Area");
    // The radio field carries stable option ids.
    const condition = area.fields.find((f) => f.id === "f_condition");
    expect(condition.type).toBe("radio");
    expect(condition.config.options.map((o) => o.id)).toEqual(["o_good", "o_fair", "o_poor"]);
  });

  it("only uses declared field types", () => {
    for (const sec of STARTER_TEMPLATE.sections) {
      for (const f of sec.fields) {
        expect(FIELD_TYPES).toHaveProperty(f.type);
      }
    }
  });
});
