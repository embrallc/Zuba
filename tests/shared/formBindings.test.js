import { describe, expect, it } from "vitest";
import { FORM_BINDINGS, bindingByKey } from "../../shared/formBindings.js";

describe("FORM_BINDINGS catalog", () => {
  it("has the client / property / report groups, all static scope", () => {
    expect(FORM_BINDINGS.version).toBe(1);
    expect(FORM_BINDINGS.groups.map((g) => g.id)).toEqual(["client", "property", "report"]);
    for (const g of FORM_BINDINGS.groups) {
      expect(g.scope).toBe("static");
      expect(Array.isArray(g.fields)).toBe(true);
      expect(g.fields.length).toBeGreaterThan(0);
    }
  });

  it("gives every field a well-formed descriptor with a supported type", () => {
    for (const g of FORM_BINDINGS.groups) {
      for (const f of g.fields) {
        expect(f).toHaveProperty("key");
        expect(f).toHaveProperty("label");
        expect(f).toHaveProperty("source");
        expect(["text", "date", "image"]).toContain(f.type);
        expect(f.scope).toBe("static");
      }
    }
  });

  it("keeps every binding key globally unique (keys are stored in templates)", () => {
    const keys = FORM_BINDINGS.groups.flatMap((g) => g.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("bindingByKey", () => {
  it("resolves a known key to its descriptor", () => {
    expect(bindingByKey("inspection.fullName")).toMatchObject({
      key: "inspection.fullName",
      source: "Inspections.FullName",
      type: "text",
    });
  });

  it("marks date bindings as date type", () => {
    expect(bindingByKey("report.generatedDate").type).toBe("date");
    expect(bindingByKey("inspection.scheduledAt").type).toBe("date");
  });

  it("returns null for unknown or empty keys", () => {
    expect(bindingByKey("nope.nope")).toBeNull();
    expect(bindingByKey(null)).toBeNull();
    expect(bindingByKey(undefined)).toBeNull();
  });
});
