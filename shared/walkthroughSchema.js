// ─────────────────────────────────────────────────────────────────────────────
// Walkthrough form contract — the single source of truth for the data-capture
// form shape, shared by the browser builder and the mobile app.
//
// Three layers (do not conflate):
//   1. CONTRACT  — the rules below (field types, the section/field shape).
//                  Fixed; this file IS the contract.
//   2. TEMPLATE  — one org's built form, a JSON document the builder produces
//                  by serializing its canvas. Lives in walkthrough_templates.
//   3. ANSWERS   — one inspection's filled data, shaped to a snapshot of the
//                  template. Lives in inspection_forms.answers.
//
// Template shape:
//   { version, sections: [ Section ] }
//   Section = { id, kind: "static"|"repeatable", title, addLabel?, fields:[Field] }
//   Field   = { id, type, label, required?, config? }
//
// Answers shape (every section is an instance array; static = exactly one):
//   { sections: { [sectionId]: { instances: [ { instanceId, fields:{[fieldId]:value} } ] } } }
//
// Stable ids: sections, fields, AND individual options each carry a permanent
// id. Labels are display-only — renaming a label never invalidates a stored
// answer or a report binding (the binding key IS the field id).
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

export const SECTION_KINDS = ["static", "repeatable"];

// Field catalog. `hasAnswer:false` = display-only (no stored value).
// `answer` documents the stored value shape for the types that have one.
export const FIELD_TYPES = {
  heading: { label: "Heading", hasAnswer: false }, // —
  text: { label: "Text", hasAnswer: true }, //  string
  toggle: { label: "Yes / No", hasAnswer: true }, //  boolean
  radio: { label: "Single choice", hasAnswer: true }, //  option id
  checkbox: { label: "Multiple choice", hasAnswer: true }, //  [option id]
  photo: { label: "Photos", hasAnswer: true }, //  [PhotoRef]
  severity: { label: "Severity", hasAnswer: true }, //  severity key
};

// text field looks — mirrors the report builder's field-element variants so
// the two builders speak one styling vocabulary.
export const TEXT_VARIANTS = ["line", "box", "multiline"];

// Default severity scale — matches the legacy inspection form + report
// generator color mapping so nothing visual changes.
export const SEVERITY_LEVELS = [
  { key: "ok", label: "OK", color: "#16A34A", bg: "#DCFCE7" },
  { key: "low", label: "Low", color: "#CA8A04", bg: "#FEF3C7" },
  { key: "medium", label: "Medium", color: "#EA580C", bg: "#FFEDD5" },
  { key: "critical", label: "Critical", color: "#DC2626", bg: "#FEE2E2" },
];

// A captured photo inside a `photo` field's answer array. Mirrors the legacy
// InspectionDetail row so the existing photo pipeline (cache, resize, upload,
// resolve) works unchanged — `id` plays the role of the old detailSk: it names
// the cache file ({id}.jpg) and the storage path ({org}/{user}/{id}/{ts}.jpg).
//   { id, localUri, cloudUri, note, markup }

// ── Helpers (runtime-agnostic: id generation is injected) ───────────────────

// emptyAnswers builds a blank answers object for a schema. Static sections are
// pre-seeded with one empty instance; repeatable sections start empty (the
// user taps "+ Add" to create instances). `idgen` returns a unique string.
export function emptyAnswers(schema, idgen) {
  const sections = {};
  for (const sec of schema?.sections ?? []) {
    const instances =
      sec.kind === "static" ? [{ instanceId: idgen(), fields: {} }] : [];
    sections[sec.id] = { instances };
  }
  return { sections };
}

export function makeInstance(idgen) {
  return { instanceId: idgen(), fields: {} };
}

// True when a section-scope field would have no value to resolve outside a
// repeatable section — used by the builder to flag a misplaced field and by
// the generator to skip cleanly.
export function fieldHasAnswer(type) {
  return FIELD_TYPES[type]?.hasAnswer === true;
}

// ── Starter template ────────────────────────────────────────────────────────
// What a brand-new org sees before the owner customizes anything. Ids are
// hard-coded + stable (no generation needed for a constant). The owner can
// move, restyle, or delete any of it.
export const STARTER_TEMPLATE = {
  version: SCHEMA_VERSION,
  sections: [
    {
      id: "sec_summary",
      kind: "static",
      title: "Inspection Summary",
      fields: [
        {
          id: "f_inspector",
          type: "text",
          label: "Inspector name",
          config: { variant: "line" },
        },
        { id: "f_present", type: "toggle", label: "Homeowner present?" },
        {
          id: "f_overview",
          type: "text",
          label: "Overview",
          config: { variant: "multiline" },
        },
      ],
    },
    {
      id: "sec_area",
      kind: "repeatable",
      title: "Area",
      addLabel: "Add Area",
      fields: [
        {
          id: "f_area_name",
          type: "text",
          label: "Area / room",
          config: { variant: "line" },
        },
        {
          id: "f_condition",
          type: "radio",
          label: "Overall condition:",
          config: {
            options: [
              { id: "o_good", label: "Good" },
              { id: "o_fair", label: "Fair" },
              { id: "o_poor", label: "Poor" },
            ],
          },
        },
        {
          id: "f_desc",
          type: "text",
          label: "Description",
          config: { variant: "multiline" },
        },
        { id: "f_severity", type: "severity", label: "Severity" },
        {
          id: "f_photos",
          type: "photo",
          label: "Photos",
          config: { notes: true },
        },
      ],
    },
  ],
};
