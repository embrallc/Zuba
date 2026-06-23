import {
  FORM_BINDINGS,
  bindingByKey as staticBindingByKey,
} from "../../shared/formBindings";
import { walkthroughFieldBindings } from "../../shared/walkthroughToReport";

// The report editor's binding vocabulary = the static inspection/report fields
// (client, property, report) PLUS one group per walkthrough section, derived
// live from the org's walkthrough template. The old fixed "section" group
// (section.name/notes/severity) is dropped — replaced by the real fields the
// owner built.

export function bindingGroups(walkthroughSchema) {
  const staticGroups = FORM_BINDINGS.groups.filter((g) => g.id !== "section");
  const wtGroups = [];
  for (const sec of walkthroughSchema?.sections ?? []) {
    const fields = walkthroughFieldBindings({ sections: [sec] });
    if (fields.length === 0) continue;
    wtGroups.push({
      id: sec.id,
      label: sec.title || "Section",
      scope: sec.kind === "repeatable" ? "section" : "static",
      sectionId: sec.id,
      fields,
    });
  }
  return [...staticGroups, ...wtGroups];
}

export function bindingByKey(key, walkthroughSchema) {
  if (!key) return null;
  if (key.startsWith("wt.")) {
    return (
      walkthroughFieldBindings(walkthroughSchema ?? {}).find((b) => b.key === key) ??
      null
    );
  }
  return staticBindingByKey(key);
}

// Photo-typed walkthrough bindings only — for the photo-grid "Photos from"
// picker.
export function photoBindings(walkthroughSchema) {
  return walkthroughFieldBindings(walkthroughSchema ?? {}).filter(
    (b) => b.fieldType === "photo",
  );
}

// True when a section-scope binding sits in a band that doesn't repeat over its
// home section — it can't resolve at generation time.
export function bindingMisplaced(meta, band) {
  if (!meta || meta.scope !== "section") return false;
  return !(band?.kind === "repeatable" && band?.repeat?.sectionId === meta.sectionId);
}
