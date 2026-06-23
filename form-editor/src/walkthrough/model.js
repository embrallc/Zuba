// Builder-side factories for the walkthrough template. The CONTRACT (field
// types, severity scale, text variants, starter) lives in the shared module
// so the app and the builder never drift; this file only adds the create/clone
// helpers the builder needs (the app never authors templates).
import {
  FIELD_TYPES,
  SEVERITY_LEVELS,
  STARTER_TEMPLATE,
  TEXT_VARIANTS,
} from "../../../shared/walkthroughSchema";

export { FIELD_TYPES, SEVERITY_LEVELS, STARTER_TEMPLATE, TEXT_VARIANTS };

export const makeId = (prefix = "id") => `${prefix}_${crypto.randomUUID()}`;

export function makeOption(label) {
  return { id: makeId("o"), label: label ?? "Option" };
}

// Per-type defaults for a freshly dropped field.
const FIELD_DEFAULTS = {
  heading: () => ({ label: "Section heading", config: {} }),
  text: () => ({ label: "Question or label", config: { variant: "line" } }),
  toggle: () => ({ label: "Yes / no question?", config: {} }),
  radio: () => ({
    label: "Choose one:",
    config: { options: [makeOption("Option 1"), makeOption("Option 2")] },
  }),
  checkbox: () => ({
    label: "Select all that apply:",
    config: { options: [makeOption("Option 1"), makeOption("Option 2")] },
  }),
  photo: () => ({ label: "Photos", config: { notes: true } }),
  severity: () => ({ label: "Severity", config: {} }),
};

export function makeField(type) {
  const d = FIELD_DEFAULTS[type]?.() ?? { label: "Field", config: {} };
  return { id: makeId("f"), type, label: d.label, config: d.config };
}

export function makeSection(kind = "static") {
  const section = {
    id: makeId("sec"),
    kind,
    title: kind === "repeatable" ? "New Repeating Section" : "New Section",
    fields: [],
  };
  if (kind === "repeatable") section.addLabel = "Add Item";
  return section;
}

export function cloneFieldWithNewIds(field) {
  const copy = structuredClone(field);
  copy.id = makeId("f");
  if (Array.isArray(copy.config?.options)) {
    copy.config.options = copy.config.options.map((o) => ({
      ...o,
      id: makeId("o"),
    }));
  }
  return copy;
}

export function cloneSectionWithNewIds(section) {
  const copy = structuredClone(section);
  copy.id = makeId("sec");
  copy.fields = (copy.fields ?? []).map(cloneFieldWithNewIds);
  return copy;
}

export function emptyTemplate() {
  return { version: 1, sections: [] };
}

// Left-panel field catalog (order + glyph). Labels come from the shared
// FIELD_TYPES so naming stays single-sourced.
export const PALETTE_FIELDS = [
  { type: "heading", glyph: "H" },
  { type: "text", glyph: "≡" },
  { type: "toggle", glyph: "◑" },
  { type: "radio", glyph: "◉" },
  { type: "checkbox", glyph: "☑" },
  { type: "photo", glyph: "▣" },
  { type: "severity", glyph: "▲" },
].map((f) => ({ ...f, label: FIELD_TYPES[f.type]?.label ?? f.type }));

// DnD payload MIME types — distinguish "drop a brand-new field type" from
// "reorder an existing field".
export const DND_NEW_FIELD = "application/x-wt-new-field";
export const DND_MOVE_FIELD = "application/x-wt-move-field";
