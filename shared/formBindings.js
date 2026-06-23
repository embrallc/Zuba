// ─────────────────────────────────────────────────────────────────────────────
// Form Builder data bindings — single source of truth.
//
// This file is the ONLY place you touch to expose a new app/database field to
// the form editor. Add an entry here, rebuild the editor bundle
// (`npm run editor:deploy`), and the field appears in the editor's
// "Data Fields" palette automatically. The report generator resolves the same
// keys at generation time, so both sides stay in lockstep.
//
// Field shape:
//   key    — stable identifier stored in templates. NEVER change a shipped
//            key; add a new one and deprecate the old.
//   label  — what the user sees in the palette and on the canvas chip.
//   type   — "text" | "date" | "image". Image bindings can't be dropped into
//            text; date bindings get formatted at generation time.
//   source — where the generator pulls the value from. "Table.Column" for
//            direct fields, "computed:<name>" for values assembled in code.
//   scope  — "static": one value per report (resolved once).
//            "section": one value per walkthrough section (only valid inside
//            a REPEATABLE band; the editor flags misplaced chips).
//
// Group shape: { id, label, scope, fields[] } — groups drive the palette's
// collapsible headers, so keep them small and task-oriented.
// ─────────────────────────────────────────────────────────────────────────────

export const FORM_BINDINGS = {
  version: 1,
  groups: [
    {
      id: "client",
      label: "Client",
      scope: "static",
      fields: [
        { key: "inspection.fullName", label: "Customer Name", type: "text", source: "Inspections.FullName", scope: "static" },
        { key: "inspection.phone", label: "Customer Phone", type: "text", source: "Inspections.Phone", scope: "static" },
        { key: "inspection.email", label: "Customer Email", type: "text", source: "Inspections.Email", scope: "static" },
      ],
    },
    {
      id: "property",
      label: "Property",
      scope: "static",
      fields: [
        { key: "inspection.addressLine1", label: "Address Line 1", type: "text", source: "Inspections.AddressLine1", scope: "static" },
        { key: "inspection.addressLine2", label: "Address Line 2", type: "text", source: "Inspections.AddressLine2", scope: "static" },
        { key: "inspection.city", label: "City", type: "text", source: "Inspections.City", scope: "static" },
        { key: "inspection.state", label: "State", type: "text", source: "Inspections.State", scope: "static" },
        { key: "inspection.zipCode", label: "Zip Code", type: "text", source: "Inspections.ZipCode", scope: "static" },
        { key: "inspection.scheduledAt", label: "Inspection Date", type: "date", source: "Inspections.ScheduledAt", scope: "static" },
      ],
    },
    {
      id: "report",
      label: "Report",
      scope: "static",
      fields: [
        { key: "report.generatedDate", label: "Report Date", type: "date", source: "computed:generatedDate", scope: "static" },
        { key: "report.inspectorName", label: "Inspector Name", type: "text", source: "computed:inspectorName", scope: "static" },
        { key: "report.orgName", label: "Company Name", type: "text", source: "Organizations.OrgName", scope: "static" },
        { key: "inspection.summary", label: "Report Summary", type: "text", source: "Inspections.Summary", scope: "static" },
      ],
    },
  ],
};

// Flat lookup used by the editor (chip rendering, validation) and the
// generator (value resolution).
export function bindingByKey(key) {
  for (const g of FORM_BINDINGS.groups) {
    for (const f of g.fields) {
      if (f.key === key) return f;
    }
  }
  return null;
}
