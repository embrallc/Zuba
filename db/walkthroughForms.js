import * as Crypto from "expo-crypto";
import { emptyAnswers } from "../shared/walkthroughSchema";
import { supabase } from "../utils/supabase";
import { db } from "./index";
import { logError } from "./logs";

// Data access for the walkthrough-form model (Phase 1 foundation):
//   - WalkthroughTemplate: a local, pull-only cache of the org's published
//     template, so walkthroughs render offline.
//   - InspectionForm: the 1:1 per-inspection { schema_snapshot, answers } row
//     that replaces InspectionDescription + InspectionDetail.
//
// The renderer (Phase 4) and sync (Phase 3) build on these; nothing wires
// inspection creation to ensureInspectionForm yet, so this is purely additive.

export function newId(prefix = "id") {
  return `${prefix}_${Crypto.randomUUID()}`;
}

// ── Template cache ──────────────────────────────────────────────────────────

export async function getCachedTemplate(orgSk) {
  try {
    if (!orgSk) return null;
    const row = await db.getFirstAsync(
      `SELECT PublishedSchema, PublishedVersion FROM WalkthroughTemplate WHERE OrgSk = ?`,
      [orgSk],
    );
    if (!row?.PublishedSchema) return null;
    return {
      schema: JSON.parse(row.PublishedSchema),
      version: row.PublishedVersion ?? 0,
    };
  } catch (e) {
    logError(e, `db/walkthroughForms.getCachedTemplate org=${orgSk}`);
    return null;
  }
}

export async function cacheTemplate(orgSk, schema, version) {
  try {
    if (!orgSk || !schema) return;
    await db.runAsync(
      `INSERT INTO WalkthroughTemplate (OrgSk, PublishedSchema, PublishedVersion, UpdatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(OrgSk) DO UPDATE SET
         PublishedSchema  = excluded.PublishedSchema,
         PublishedVersion = excluded.PublishedVersion,
         UpdatedAt        = excluded.UpdatedAt`,
      [orgSk, JSON.stringify(schema), version ?? 0, Date.now()],
    );
  } catch (e) {
    logError(e, `db/walkthroughForms.cacheTemplate org=${orgSk}`);
  }
}

// Fetch the org's published template from the cloud and cache it. Used as a
// fallback when the form opens before a sync has cached it (RLS lets any org
// member read their org's row). Returns { schema, version } or null.
export async function fetchAndCacheTemplate(orgSk) {
  try {
    if (!orgSk) return null;
    const { data, error } = await supabase
      .from("walkthrough_templates")
      .select("published_schema, published_version")
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (error) throw error;
    if (data?.published_schema) {
      const version = data.published_version ?? 0;
      await cacheTemplate(orgSk, data.published_schema, version);
      return { schema: data.published_schema, version };
    }
    return null;
  } catch (e) {
    logError(e, `db/walkthroughForms.fetchAndCacheTemplate org=${orgSk}`);
    return null;
  }
}

// ── Per-inspection form (1:1) ───────────────────────────────────────────────

export async function getInspectionForm(inspectionSk) {
  try {
    if (!inspectionSk) return null;
    const row = await db.getFirstAsync(
      `SELECT * FROM InspectionForm WHERE InspectionSk = ? AND _deleted = 0`,
      [inspectionSk],
    );
    if (!row) return null;
    return {
      InspectionSk: row.InspectionSk,
      schema: row.SchemaSnapshot ? JSON.parse(row.SchemaSnapshot) : null,
      answers: row.Answers ? JSON.parse(row.Answers) : { sections: {} },
      templateVersion: row.TemplateVersion ?? 0,
    };
  } catch (e) {
    logError(e, `db/walkthroughForms.getInspectionForm sk=${inspectionSk}`);
    return null;
  }
}

// Create the 1:1 form row for an inspection, snapshotting the given published
// template. Idempotent — returns the existing form if one is already present,
// so it's safe to call on every open.
export async function ensureInspectionForm(inspectionSk, schema, version) {
  try {
    if (!inspectionSk) return null;
    const existing = await getInspectionForm(inspectionSk);
    if (existing) {
      // Self-heal: a form created before the template was available (e.g.
      // offline) has a null snapshot. Backfill it now WITHOUT touching the
      // answers, so the inspection becomes renderable.
      if (!existing.schema && schema) {
        const now = Date.now();
        await db.runAsync(
          `UPDATE InspectionForm
             SET SchemaSnapshot = ?, TemplateVersion = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
           WHERE InspectionSk = ?`,
          [JSON.stringify(schema), version ?? 0, now, inspectionSk],
        );
        return { ...existing, schema, templateVersion: version ?? 0 };
      }
      return existing;
    }

    const answers = emptyAnswers(schema, () => newId("i"));
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO InspectionForm
         (InspectionSk, SchemaSnapshot, Answers, TemplateVersion, _version, _lastChangedAt, _deleted, Synced)
       VALUES (?, ?, ?, ?, 1, ?, 0, 0)`,
      [
        inspectionSk,
        schema ? JSON.stringify(schema) : null,
        JSON.stringify(answers),
        version ?? 0,
        now,
      ],
    );
    return {
      InspectionSk: inspectionSk,
      schema: schema ?? null,
      answers,
      templateVersion: version ?? 0,
    };
  } catch (e) {
    logError(e, `db/walkthroughForms.ensureInspectionForm sk=${inspectionSk}`);
    return null;
  }
}

// Persist the full answers object after an edit. The renderer owns the merge
// and hands us the complete next state; we bump _version + clear Synced so the
// push picks it up (one sync unit per inspection — see the redesign notes).
export async function saveAnswers(inspectionSk, answers) {
  try {
    if (!inspectionSk) return;
    await db.runAsync(
      `UPDATE InspectionForm
         SET Answers = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionSk = ?`,
      [JSON.stringify(answers ?? { sections: {} }), Date.now(), inspectionSk],
    );
  } catch (e) {
    logError(e, `db/walkthroughForms.saveAnswers sk=${inspectionSk}`);
    throw e;
  }
}

// Soft-delete the form alongside its inspection (kept symmetric with the
// inspection tombstone; the sync layer will propagate it in Phase 3).
export async function deleteInspectionForm(inspectionSk) {
  try {
    if (!inspectionSk) return;
    await db.runAsync(
      `UPDATE InspectionForm
         SET _deleted = 1, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionSk = ?`,
      [Date.now(), inspectionSk],
    );
  } catch (e) {
    logError(e, `db/walkthroughForms.deleteInspectionForm sk=${inspectionSk}`);
  }
}
