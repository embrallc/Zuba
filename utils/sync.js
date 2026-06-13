import dayjs from "dayjs";
import { db } from "../db/index";
import { logError } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { resolveLocalFileUri, uploadInspectionPhoto } from "./inspectionPhotos";
import { supabase } from "./supabase";

function cloudInspectionToStoreObj(r) {
  return {
    InspectionSk: r.inspection_sk,
    UserSk: r.user_id,
    FullName: r.full_name ?? null,
    Summary: r.summary ?? null,
    AddressLine1: r.address_line1 ?? null,
    AddressLine2: r.address_line2 ?? null,
    City: r.city ?? null,
    State: r.state ?? null,
    ZipCode: r.zip_code ?? null,
    ScheduledAt: r.scheduled_at ?? null,
    Phone: r.phone ?? null,
    Email: r.email ?? null,
    Longitude: r.longitude ?? null,
    Latitude: r.latitude ?? null,
    Status: r.status ?? "OPEN",
    _version: r._version ?? 1,
    _lastChangedAt: r._last_changed_at ?? null,
    _deleted: r._deleted ? 1 : 0,
    Synced: 1,
  };
}

// PostgREST caps any single response at 1000 rows. Without paging, rows past
// the cap silently vanish from a pull — and the prune phase would then DELETE
// their local copies. Ordered by primary key so pages are stable across
// requests; throws on any page error so the caller's seen-set is never
// partial.
const PULL_PAGE_SIZE = 1000;

async function fetchAllUserRows(table, pkColumn, userId) {
  const all = [];
  for (let from = 0; ; from += PULL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("user_id", userId)
      .order(pkColumn, { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < PULL_PAGE_SIZE) break;
  }
  return all;
}

// PostgREST reports an RLS write rejection as 42501. The expected cause here
// is a row that was reassigned to a teammate while this device still held an
// unsynced edit — it's no longer ours to write. The caller marks it Synced
// so it stops retrying forever; the next pull won't return it for us, so the
// normal prune path removes the local copy. If a 42501 ever came from a
// policy misconfig instead, the row WOULD still be returned by our pull and
// nothing gets deleted — safe in both directions.
function isRlsDenied(e) {
  return e?.code === "42501" || /row-level security/i.test(e?.message ?? "");
}

// ─── PUSH ─────────────────────────────────────────────────────────────────────
// For each table: query Synced = 0, upsert to Supabase, mark Synced = 1 on success.
// user_id is the Supabase auth UID (session.user.id) — required for cloud RLS.
//
// Synced = 1 is only written when the row is still byte-identical to what we
// pushed (same _lastChangedAt / UpdatedAt) — an edit made WHILE the upsert
// was in flight keeps the row dirty so the next sync pushes it.

async function pushInspections(userId) {
  const rows = db.getAllSync(`SELECT * FROM Inspections WHERE Synced = 0`);
  if (!rows.length) return;

  // Per-row push so a single upsert failure can't strand the others with
  // Synced = 0 (which would re-push everything on the next sync — risking a
  // clobber of a teammate's intervening cloud edit).
  for (const r of rows) {
    try {
      const { error } = await supabase.from("inspections").upsert(
        {
          inspection_sk: r.InspectionSk,
          user_id: userId,
          full_name: r.FullName ?? null,
          summary: r.Summary ?? null,
          address_line1: r.AddressLine1 ?? null,
          address_line2: r.AddressLine2 ?? null,
          city: r.City ?? null,
          state: r.State ?? null,
          zip_code: r.ZipCode ?? null,
          scheduled_at: r.ScheduledAt ?? null,
          phone: r.Phone ?? null,
          email: r.Email ?? null,
          longitude: r.Longitude ?? null,
          latitude: r.Latitude ?? null,
          status: r.Status ?? "OPEN",
          _version: r._version ?? 1,
          _last_changed_at: r._lastChangedAt ?? null,
          _deleted: !!r._deleted,
        },
        { onConflict: "inspection_sk" },
      );
      if (error) throw error;
      await db.runAsync(
        `UPDATE Inspections SET Synced = 1
         WHERE InspectionSk = ? AND IFNULL(_lastChangedAt, 0) = ?`,
        [r.InspectionSk, r._lastChangedAt ?? 0],
      );
    } catch (e) {
      if (isRlsDenied(e)) {
        await db
          .runAsync(`UPDATE Inspections SET Synced = 1 WHERE InspectionSk = ?`, [
            r.InspectionSk,
          ])
          .catch(() => {});
        logError(e, `sync/pushInspections:rls-denied ${r?.InspectionSk}`);
      } else {
        logError(e, `sync/pushInspections:${r?.InspectionSk ?? "unknown"}`);
      }
    }
  }
}

async function pushInspectionDescriptions(userId) {
  const rows = db.getAllSync(
    `SELECT * FROM InspectionDescription WHERE Synced = 0`,
  );
  if (!rows.length) return;

  for (const r of rows) {
    try {
      const { error } = await supabase.from("inspection_descriptions").upsert(
        {
          inspection_description_sk: r.InspectionDescriptionSk,
          inspection_sk: r.InspectionSk,
          user_id: userId,
          description: r.Description ?? null,
          notes: r.Notes ?? null,
          position: r.Position ?? 0,
          severity_level: r.SeverityLevel ?? null,
          _version: r._version ?? 1,
          _last_changed_at: r._lastChangedAt ?? null,
          _deleted: !!r._deleted,
        },
        { onConflict: "inspection_description_sk" },
      );
      if (error) throw error;
      await db.runAsync(
        `UPDATE InspectionDescription SET Synced = 1
         WHERE InspectionDescriptionSk = ? AND IFNULL(_lastChangedAt, 0) = ?`,
        [r.InspectionDescriptionSk, r._lastChangedAt ?? 0],
      );
    } catch (e) {
      if (isRlsDenied(e)) {
        await db
          .runAsync(
            `UPDATE InspectionDescription SET Synced = 1 WHERE InspectionDescriptionSk = ?`,
            [r.InspectionDescriptionSk],
          )
          .catch(() => {});
        logError(
          e,
          `sync/pushInspectionDescriptions:rls-denied ${r?.InspectionDescriptionSk}`,
        );
      } else {
        logError(
          e,
          `sync/pushInspectionDescriptions:${r?.InspectionDescriptionSk ?? "unknown"}`,
        );
      }
    }
  }
}

async function pushInspectionDetails(userId) {
  const rows = db.getAllSync(`SELECT * FROM InspectionDetail WHERE Synced = 0`);
  console.log(`[sync] pushInspectionDetails: ${rows.length} dirty row(s)`);
  if (!rows.length) return;

  // OrgSk is part of the cloud bucket path. Pull once for the whole batch.
  let orgSk = null;
  try {
    const userRow = db.getFirstSync(
      `SELECT OrgSk FROM Users WHERE UserId = ?`,
      [userId],
    );
    orgSk = userRow?.OrgSk ?? null;
  } catch (e) {
    logError(e, "sync/pushInspectionDetails:lookupOrgSk");
  }
  if (!orgSk) {
    console.warn(
      `[sync] pushInspectionDetails: OrgSk missing for userId=${userId} — photo uploads will be SKIPPED`,
    );
  }

  // Per-row push: each row may need a Storage upload before the DB upsert.
  for (const r of rows) {
    try {
      let cloudUri = r.CloudPictureURI ?? null;

      // Upload the photo if we have a local copy and no cloud key yet.
      // Skip deleted rows — no point uploading something we're tombstoning.
      // A LocalPictureURI whose underlying file no longer exists is
      // unrecoverable — treat it as "nothing to upload" so the row doesn't
      // retry on every sync forever.
      let localFileUri = null;
      if (!cloudUri && r.LocalPictureURI && !r._deleted) {
        localFileUri = await resolveLocalFileUri(r.LocalPictureURI);
        if (!localFileUri) {
          console.warn(
            `[sync] detail ${r.InspectionDetailSk}: local photo file gone — nothing to upload`,
          );
        }
      }
      const needsUpload = !!localFileUri;
      if (needsUpload && !orgSk) {
        console.warn(
          `[sync] detail ${r.InspectionDetailSk}: skipping upload — no OrgSk`,
        );
      }
      if (needsUpload && orgSk) {
        console.log(
          `[sync] detail ${r.InspectionDetailSk}: uploading local=${r.LocalPictureURI}`,
        );
        const uploaded = await uploadInspectionPhoto({
          localUri: r.LocalPictureURI,
          orgSk,
          userId,
          detailSk: r.InspectionDetailSk,
        });
        if (uploaded) {
          console.log(
            `[sync] detail ${r.InspectionDetailSk}: uploaded → ${uploaded}`,
          );
          cloudUri = uploaded;
          try {
            await db.runAsync(
              `UPDATE InspectionDetail SET CloudPictureURI = ? WHERE InspectionDetailSk = ?`,
              [cloudUri, r.InspectionDetailSk],
            );
          } catch (e) {
            logError(
              e,
              `sync/pushInspectionDetails:saveCloudUri ${r.InspectionDetailSk}`,
            );
          }
        } else {
          console.warn(
            `[sync] detail ${r.InspectionDetailSk}: upload returned null`,
          );
        }
        // If upload failed, cloudUri stays null. Row still upserts below (so
        // notes/markup/deletes propagate) but stays Synced = 0 — see
        // uploadPending — so the next syncAll actually retries the photo.
      }

      // A photo that still needs uploading (upload failed, or no OrgSk yet)
      // must keep the row dirty. Marking it synced would mean the upload is
      // never retried — and once the OS purges the cache copy, the photo
      // would be gone everywhere.
      const uploadPending = needsUpload && !cloudUri;

      const { error } = await supabase.from("inspection_details").upsert(
        {
          inspection_detail_sk: r.InspectionDetailSk,
          inspection_description_sk: r.InspectionDescriptionSk,
          user_id: userId,
          local_picture_uri: r.LocalPictureURI ?? null,
          cloud_picture_uri: cloudUri,
          picture_note: r.PictureNote ?? null,
          picture_markup: r.PictureMarkup ?? null,
          _version: r._version ?? 1,
          _last_changed_at: r._lastChangedAt ?? null,
          _deleted: !!r._deleted,
        },
        { onConflict: "inspection_detail_sk" },
      );
      if (error) throw error;

      if (!uploadPending) {
        await db.runAsync(
          `UPDATE InspectionDetail SET Synced = 1
           WHERE InspectionDetailSk = ? AND IFNULL(_lastChangedAt, 0) = ?`,
          [r.InspectionDetailSk, r._lastChangedAt ?? 0],
        );
      }
    } catch (e) {
      if (isRlsDenied(e)) {
        await db
          .runAsync(
            `UPDATE InspectionDetail SET Synced = 1 WHERE InspectionDetailSk = ?`,
            [r.InspectionDetailSk],
          )
          .catch(() => {});
        logError(
          e,
          `sync/pushInspectionDetails:rls-denied ${r?.InspectionDetailSk}`,
        );
      } else {
        logError(
          e,
          `sync/pushInspectionDetails:${r?.InspectionDetailSk ?? "unknown"}`,
        );
      }
    }
  }
}

async function pushSectionTemplates(userId) {
  const rows = db.getAllSync(`SELECT * FROM SectionTemplate WHERE Synced = 0`);
  if (!rows.length) return;

  for (const r of rows) {
    try {
      const { error } = await supabase.from("section_templates").upsert(
        {
          section_template_sk: r.SectionTemplateSk,
          user_id: userId,
          name: r.Name,
          position: r.Position ?? 0,
          created_at: r.CreatedAt,
          updated_at: r.UpdatedAt,
        },
        { onConflict: "section_template_sk" },
      );
      if (error) throw error;
      await db.runAsync(
        `UPDATE SectionTemplate SET Synced = 1
         WHERE SectionTemplateSk = ? AND IFNULL(UpdatedAt, '') = ?`,
        [r.SectionTemplateSk, r.UpdatedAt ?? ""],
      );
    } catch (e) {
      logError(
        e,
        `sync/pushSectionTemplates:${r?.SectionTemplateSk ?? "unknown"}`,
      );
    }
  }
}

async function pushSmsTemplates(userId) {
  const rows = db.getAllSync(`SELECT * FROM SmsTemplate WHERE Synced = 0`);
  if (!rows.length) return;

  for (const r of rows) {
    try {
      const { error } = await supabase.from("sms_templates").upsert(
        {
          sms_template_sk: r.SmsTemplateSk,
          user_id: userId,
          name: r.Name,
          body: r.Body,
          position: r.Position ?? 0,
          created_at: r.CreatedAt,
          updated_at: r.UpdatedAt,
        },
        { onConflict: "sms_template_sk" },
      );
      if (error) throw error;
      await db.runAsync(
        `UPDATE SmsTemplate SET Synced = 1
         WHERE SmsTemplateSk = ? AND IFNULL(UpdatedAt, '') = ?`,
        [r.SmsTemplateSk, r.UpdatedAt ?? ""],
      );
    } catch (e) {
      logError(e, `sync/pushSmsTemplates:${r?.SmsTemplateSk ?? "unknown"}`);
    }
  }
}

async function pushSmsStatus(userId) {
  const rows = db.getAllSync(`SELECT * FROM SmsStatus WHERE Synced = 0`);
  if (!rows.length) return;

  for (const r of rows) {
    try {
      const { error } = await supabase.from("sms_status").upsert(
        {
          sms_status_sk: r.SmsStatusSk,
          user_id: userId,
          inspection_sk: r.InspectionSk,
          sms_template_sk: r.SmsTemplateSk,
          sent: !!r.Sent,
          sent_at: r.SentAt ?? null,
          _version: r._version ?? 1,
          _last_changed_at: r._lastChangedAt ?? null,
          _deleted: !!r._deleted,
        },
        { onConflict: "sms_status_sk" },
      );
      if (error) throw error;
      await db.runAsync(
        `UPDATE SmsStatus SET Synced = 1
         WHERE SmsStatusSk = ? AND IFNULL(_lastChangedAt, 0) = ?`,
        [r.SmsStatusSk, r._lastChangedAt ?? 0],
      );
    } catch (e) {
      if (isRlsDenied(e)) {
        await db
          .runAsync(`UPDATE SmsStatus SET Synced = 1 WHERE SmsStatusSk = ?`, [
            r.SmsStatusSk,
          ])
          .catch(() => {});
        logError(e, `sync/pushSmsStatus:rls-denied ${r?.SmsStatusSk}`);
      } else {
        logError(e, `sync/pushSmsStatus:${r?.SmsStatusSk ?? "unknown"}`);
      }
    }
  }
}

// ─── PULL ─────────────────────────────────────────────────────────────────────
// Each pull explicitly filters by `user_id = self` (rather than relying on
// RLS to scope rows) so the local DB stays a strict mirror of the calling
// user's own work — even owners/admins whose RLS would let them see the
// whole org. Cross-team views (All Inspections, Unassigned Records) query
// the cloud directly via their own RPCs.
//
// Each pull returns a Set of cloud SKs so the prune phase can delete local
// rows the cloud no longer attributes to us (e.g. an owner reassigned the
// inspection to a teammate).
//
// Conflict rule: if cloud _version > local _version → update local.
// Tables without _version (SectionTemplate, SmsTemplate) use UpdatedAt.

async function pullInspections(userId) {
  const data = await fetchAllUserRows("inspections", "inspection_sk", userId);

  const seen = new Set();
  const store = useInspectionStore.getState();

  for (const r of data ?? []) {
    seen.add(r.inspection_sk);
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM Inspections WHERE InspectionSk = ?`,
        [r.inspection_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO Inspections
           (InspectionSk, UserSk, FullName, Summary, AddressLine1, AddressLine2, City, State,
            ZipCode, ScheduledAt, Phone, Email, Longitude, Latitude, Status,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            r.inspection_sk,
            r.user_id,
            r.full_name,
            r.summary,
            r.address_line1,
            r.address_line2,
            r.city,
            r.state,
            r.zip_code,
            r.scheduled_at,
            r.phone,
            r.email,
            r.longitude,
            r.latitude,
            r.status ?? "OPEN",
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            1,
          ],
        );
        // Mirror getAllInspections' active-set rule: a CLOSED (completed) or
        // deleted row stays in SQLite but must not enter the in-memory store
        // that feeds the calendar/list views.
        if (!r._deleted && (r.status ?? "OPEN") !== "CLOSED") {
          store.add(cloudInspectionToStoreObj(r));
        }
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE Inspections SET
           UserSk=?, FullName=?, Summary=?, AddressLine1=?, AddressLine2=?, City=?, State=?,
           ZipCode=?, ScheduledAt=?, Phone=?, Email=?, Longitude=?, Latitude=?, Status=?,
           _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionSk=?`,
          [
            r.user_id,
            r.full_name,
            r.summary,
            r.address_line1,
            r.address_line2,
            r.city,
            r.state,
            r.zip_code,
            r.scheduled_at,
            r.phone,
            r.email,
            r.longitude,
            r.latitude,
            r.status ?? "OPEN",
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            r.inspection_sk,
          ],
        );
        // A row that became deleted OR completed (CLOSED) on another device
        // must leave the active store; otherwise mirror the update.
        if (r._deleted || (r.status ?? "OPEN") === "CLOSED") {
          store.remove(r.inspection_sk);
        } else {
          store.update(cloudInspectionToStoreObj(r));
        }
      }
    } catch (e) {
      logError(e, `sync/pullInspections:${r?.inspection_sk ?? "unknown"}`);
    }
  }
  return seen;
}

async function pullInspectionDescriptions(userId) {
  const data = await fetchAllUserRows(
    "inspection_descriptions",
    "inspection_description_sk",
    userId,
  );

  const seen = new Set();
  for (const r of data ?? []) {
    seen.add(r.inspection_description_sk);
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM InspectionDescription WHERE InspectionDescriptionSk = ?`,
        [r.inspection_description_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO InspectionDescription
           (InspectionDescriptionSk, InspectionSk, Description, Notes, Position, SeverityLevel,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            r.inspection_description_sk,
            r.inspection_sk,
            r.description,
            r.notes,
            r.position ?? 0,
            r.severity_level ?? null,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE InspectionDescription SET
           InspectionSk=?, Description=?, Notes=?, Position=?, SeverityLevel=?,
           _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionDescriptionSk=?`,
          [
            r.inspection_sk,
            r.description,
            r.notes,
            r.position ?? 0,
            r.severity_level ?? null,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            r.inspection_description_sk,
          ],
        );
      }
    } catch (e) {
      logError(
        e,
        `sync/pullInspectionDescriptions:${r?.inspection_description_sk ?? "unknown"}`,
      );
    }
  }
  return seen;
}

async function pullInspectionDetails(userId) {
  const data = await fetchAllUserRows(
    "inspection_details",
    "inspection_detail_sk",
    userId,
  );

  const seen = new Set();
  for (const r of data ?? []) {
    seen.add(r.inspection_detail_sk);
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM InspectionDetail WHERE InspectionDetailSk = ?`,
        [r.inspection_detail_sk],
      );
      if (!local) {
        // Mirror the cloud row directly. LocalPictureURI may point to a path
        // that doesn't exist on this device — resolvePhotoUri handles that
        // by falling back to a signed cloud URL.
        await db.runAsync(
          `INSERT OR IGNORE INTO InspectionDetail
           (InspectionDetailSk, InspectionDescriptionSk, LocalPictureURI, CloudPictureURI, PictureNote, PictureMarkup,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            r.inspection_detail_sk,
            r.inspection_description_sk,
            r.local_picture_uri ?? null,
            r.cloud_picture_uri ?? null,
            r.picture_note ?? null,
            r.picture_markup ?? null,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE InspectionDetail SET
           InspectionDescriptionSk=?, LocalPictureURI=?, CloudPictureURI=?, PictureNote=?, PictureMarkup=?,
           _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionDetailSk=?`,
          [
            r.inspection_description_sk,
            r.local_picture_uri ?? null,
            r.cloud_picture_uri ?? null,
            r.picture_note,
            r.picture_markup,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            r.inspection_detail_sk,
          ],
        );
      }
    } catch (e) {
      logError(
        e,
        `sync/pullInspectionDetails:${r?.inspection_detail_sk ?? "unknown"}`,
      );
    }
  }
  return seen;
}

async function pullSectionTemplates(userId) {
  // Templates are per-user; explicitly scope to self so an owner whose RLS
  // can see other users' rows doesn't accidentally import their templates
  // into local SQLite.
  const data = await fetchAllUserRows(
    "section_templates",
    "section_template_sk",
    userId,
  );

  const seen = new Set();
  for (const r of data ?? []) {
    seen.add(r.section_template_sk);
    try {
      const local = db.getFirstSync(
        `SELECT UpdatedAt FROM SectionTemplate WHERE SectionTemplateSk = ?`,
        [r.section_template_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO SectionTemplate
           (SectionTemplateSk, UserSk, Name, Position, CreatedAt, UpdatedAt, Synced)
           VALUES (?,?,?,?,?,?,?)`,
          [
            r.section_template_sk,
            r.user_id,
            r.name,
            r.position ?? 0,
            r.created_at,
            r.updated_at,
            1,
          ],
        );
      } else if (
        dayjs(r.updated_at).valueOf() > dayjs(local.UpdatedAt).valueOf()
      ) {
        await db.runAsync(
          `UPDATE SectionTemplate SET Name=?, Position=?, UpdatedAt=?, Synced=1
           WHERE SectionTemplateSk=?`,
          [r.name, r.position ?? 0, r.updated_at, r.section_template_sk],
        );
      }
    } catch (e) {
      logError(
        e,
        `sync/pullSectionTemplates:${r?.section_template_sk ?? "unknown"}`,
      );
    }
  }
  return seen;
}

async function pullSmsTemplates(userId) {
  const data = await fetchAllUserRows("sms_templates", "sms_template_sk", userId);

  const seen = new Set();
  for (const r of data ?? []) {
    seen.add(r.sms_template_sk);
    try {
      const local = db.getFirstSync(
        `SELECT UpdatedAt FROM SmsTemplate WHERE SmsTemplateSk = ?`,
        [r.sms_template_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO SmsTemplate
           (SmsTemplateSk, UserSk, Name, Body, Position, CreatedAt, UpdatedAt, Synced)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            r.sms_template_sk,
            r.user_id,
            r.name,
            r.body,
            r.position ?? 0,
            r.created_at,
            r.updated_at,
            1,
          ],
        );
      } else if (
        dayjs(r.updated_at).valueOf() > dayjs(local.UpdatedAt).valueOf()
      ) {
        await db.runAsync(
          `UPDATE SmsTemplate SET Name=?, Body=?, Position=?, UpdatedAt=?, Synced=1
           WHERE SmsTemplateSk=?`,
          [r.name, r.body, r.position ?? 0, r.updated_at, r.sms_template_sk],
        );
      }
    } catch (e) {
      logError(e, `sync/pullSmsTemplates:${r?.sms_template_sk ?? "unknown"}`);
    }
  }
  return seen;
}

async function pullSmsStatus(userId) {
  const data = await fetchAllUserRows("sms_status", "sms_status_sk", userId);

  const seen = new Set();
  for (const r of data ?? []) {
    seen.add(r.sms_status_sk);
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM SmsStatus WHERE SmsStatusSk = ?`,
        [r.sms_status_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO SmsStatus
           (SmsStatusSk, UserSk, InspectionSk, SmsTemplateSk, Sent, SentAt,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            r.sms_status_sk,
            r.user_id,
            r.inspection_sk,
            r.sms_template_sk,
            r.sent ? 1 : 0,
            r.sent_at ?? null,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE SmsStatus SET
           Sent=?, SentAt=?, _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE SmsStatusSk=?`,
          [
            r.sent ? 1 : 0,
            r.sent_at ?? null,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            r.sms_status_sk,
          ],
        );
      }
    } catch (e) {
      logError(e, `sync/pullSmsStatus:${r?.sms_status_sk ?? "unknown"}`);
    }
  }
  return seen;
}

// ─── PRUNE ────────────────────────────────────────────────────────────────────
// After the pull phase, delete any locally-synced rows whose SK isn't in the
// cloud's response for this user. This is how reassign-away propagates — the
// inspection still exists in the cloud but the caller no longer owns it, so
// it's no longer returned by the user-scoped pull and we remove it locally.
//
// Conservative: only touches Synced = 1 / _deleted = 0 rows. Unsynced local
// edits and pending tombstones are left alone so a push retry can finish.
// Children deleted before parents to satisfy FK constraints.

function pruneTable(table, skColumn, seen, onRemove, hasDeleted = true) {
  const where = hasDeleted ? "Synced = 1 AND _deleted = 0" : "Synced = 1";
  const rows = db.getAllSync(
    `SELECT ${skColumn} AS sk FROM ${table} WHERE ${where}`,
  );
  let removed = 0;
  for (const r of rows) {
    if (!seen.has(r.sk)) {
      try {
        db.runSync(`DELETE FROM ${table} WHERE ${skColumn} = ?`, [r.sk]);
        if (onRemove) onRemove(r.sk);
        removed++;
      } catch (e) {
        logError(e, `sync/prune:${table}:${r.sk}`);
      }
    }
  }
  if (removed > 0) console.log(`[sync] pruned ${removed} row(s) from ${table}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
// Call on app open (after auth check) and after login.
// Fire-and-forget: caller does not need to await.
//
// Re-entrancy: boot fires syncAll twice (init + onAuthStateChange), and
// pull-to-refresh / report generation can overlap either. Two interleaved
// runs could prune rows the other just pushed, so concurrent callers share
// the one in-flight run instead of starting another.

let syncInFlight = null;

export function syncAll() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncAll().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function doSyncAll() {
  try {
    console.log("[sync] syncAll starting");
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user?.id) {
      console.log("[sync] syncAll: no session, skipping");
      return;
    }
    const userId = session.user.id;

    // Push phase — push local changes to cloud before pulling
    // FK order: parent tables before children
    const pushSteps = [
      ["pushInspections", () => pushInspections(userId)],
      ["pushInspectionDescriptions", () => pushInspectionDescriptions(userId)],
      ["pushInspectionDetails", () => pushInspectionDetails(userId)],
      ["pushSectionTemplates", () => pushSectionTemplates(userId)],
      ["pushSmsTemplates", () => pushSmsTemplates(userId)],
      ["pushSmsStatus", () => pushSmsStatus(userId)],
    ];
    for (const [name, fn] of pushSteps) {
      try {
        console.log(`[sync] starting ${name}`);
        await fn();
        console.log(`[sync] done ${name}`);
      } catch (e) {
        console.error(`[sync] ERROR in ${name}:`, e?.message);
        logError(e, `sync/${name}`);
      }
    }

    // Pull phase — bring down anything missing or newer on cloud.
    // Parent-first so child INSERTs satisfy FK constraints. Each user-scoped
    // pull returns the set of SKs the cloud attributes to this user, which
    // the prune phase below uses to delete locally-stale rows.
    let inspectionSks = new Set();
    let descriptionSks = new Set();
    let detailSks = new Set();
    let sectionTplSks = new Set();
    let smsTplSks = new Set();
    let smsStatusSks = new Set();
    const pullSteps = [
      [
        "pullInspections",
        async () => {
          inspectionSks = await pullInspections(userId);
        },
      ],
      [
        "pullInspectionDescriptions",
        async () => {
          descriptionSks = await pullInspectionDescriptions(userId);
        },
      ],
      [
        "pullInspectionDetails",
        async () => {
          detailSks = await pullInspectionDetails(userId);
        },
      ],
      [
        "pullSectionTemplates",
        async () => {
          sectionTplSks = await pullSectionTemplates(userId);
        },
      ],
      [
        "pullSmsTemplates",
        async () => {
          smsTplSks = await pullSmsTemplates(userId);
        },
      ],
      [
        "pullSmsStatus",
        async () => {
          smsStatusSks = await pullSmsStatus(userId);
        },
      ],
    ];
    let pullFailures = 0;
    for (const [name, fn] of pullSteps) {
      try {
        console.log(`[sync] starting ${name}`);
        await fn();
        console.log(`[sync] done ${name}`);
      } catch (e) {
        pullFailures++;
        console.error(`[sync] ERROR in ${name}:`, e?.message);
        logError(e, `sync/${name}`);
      }
    }

    // Prune phase — remove local rows the cloud no longer returns for us.
    // Child-first so deletes don't violate FK constraints. The inspection
    // store mirror is kept in sync via the onRemove callback for the
    // top-level inspections prune.
    //
    // HARD GATE: prune compares local rows against the pulled seen-sets, so
    // it must only run when EVERY pull completed. A failed pull leaves its
    // set empty — pruning against that would delete the user's entire local
    // mirror (e.g. any sync attempted while offline).
    if (pullFailures > 0) {
      console.warn(
        `[sync] skipping prune — ${pullFailures} pull step(s) failed`,
      );
      return;
    }
    try {
      const store = useInspectionStore.getState();
      pruneTable("InspectionDetail", "InspectionDetailSk", detailSks);
      pruneTable(
        "InspectionDescription",
        "InspectionDescriptionSk",
        descriptionSks,
      );
      pruneTable("Inspections", "InspectionSk", inspectionSks, (sk) =>
        store.remove(sk),
      );
      pruneTable("SmsStatus", "SmsStatusSk", smsStatusSks);
      pruneTable(
        "SectionTemplate",
        "SectionTemplateSk",
        sectionTplSks,
        null,
        false,
      );
      pruneTable("SmsTemplate", "SmsTemplateSk", smsTplSks, null, false);
    } catch (e) {
      logError(e, "sync/prune");
    }

    console.log("[sync] syncAll complete");
  } catch (e) {
    console.error("[sync] syncAll uncaught error:", e?.message, e?.stack);
    logError(e, "sync/syncAll");
  }
}
