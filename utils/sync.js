import dayjs from "dayjs";
import { db } from "../db/index";
import { logError } from "../db/logs";
import { cacheTemplate } from "../db/walkthroughForms";
import { useInspectionStore } from "../stores/useInspectionStore";
import { uploadInspectionPhoto } from "./inspectionPhotos";
import { supabase } from "./supabase";

// The caller's org_sk — needed for the photo storage path and the walkthrough
// template pull. Read from the local Users mirror.
function getOrgSk(userId) {
  try {
    const row = db.getFirstSync(`SELECT OrgSk FROM Users WHERE UserId = ?`, [
      userId,
    ]);
    return row?.OrgSk ?? null;
  } catch (e) {
    logError(e, "sync/getOrgSk");
    return null;
  }
}

// Local CalendarSnapshot is a JSON string (or null); the cloud column is jsonb.
// Parse defensively so a malformed snapshot can't fail the whole upsert.
function snapshotForCloud(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

// Cloud calendar_snapshot (jsonb object, or already a string) → local TEXT.
function snapshotForLocal(obj) {
  if (obj == null) return null;
  if (typeof obj === "string") return obj;
  try {
    return JSON.stringify(obj);
  } catch (_) {
    return null;
  }
}

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
    HasApptReminder: r.has_appt_reminder ? 1 : 0,
    ApptReminderStatus: r.appt_reminder_status ?? "PENDING",
    PaymentState: r.payment_state ?? "none",
    ReportState: r.report_state ?? "pending",
    Paid: r.paid ? 1 : 0,
    ReportRecipients: JSON.stringify(r.report_recipients ?? []),
    CalendarEventId: r.calendar_event_id ?? null,
    CalendarOwnerDeviceId: r.calendar_owner_device_id ?? null,
    CalendarSnapshot: r.calendar_snapshot
      ? JSON.stringify(r.calendar_snapshot)
      : null,
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

// ─── INCREMENTAL PULL: manifest diff ────────────────────────────────────────
// Instead of re-downloading every full row each sync, fetch a cheap manifest of
// (pk, server_updated_at) for all of a user's rows, compare each against the
// server_updated_at we stored locally, and download the FULL row only where it
// changed (or is new). server_updated_at is set ONLY by a DB trigger, so it's
// the reliable "did this row change on the server" signal; the big payload (e.g.
// inspection_forms.answers/schema_snapshot) transfers only for changed rows.

// Cheap manifest: two small columns, no JSONB. Paged for the 1000-row PostgREST
// cap. Throws on any page error so the caller's seen-set is never partial (a
// partial seen-set would mis-drive the prune phase into deleting live rows).
async function fetchManifest(table, pkColumn, userId) {
  const manifest = new Map();
  for (let from = 0; ; from += PULL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(`${pkColumn}, server_updated_at`)
      .eq("user_id", userId)
      .order(pkColumn, { ascending: true })
      .range(from, from + PULL_PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      manifest.set(r[pkColumn], r.server_updated_at ?? 0);
    }
    if (!data || data.length < PULL_PAGE_SIZE) break;
  }
  return manifest;
}

// Full rows for a specific set of pks (those the diff flagged), chunked to keep
// each request's `in (...)` list bounded.
const FETCH_CHUNK_SIZE = 200;

async function fetchRowsByPks(table, pkColumn, pks) {
  const all = [];
  for (let i = 0; i < pks.length; i += FETCH_CHUNK_SIZE) {
    const chunk = pks.slice(i, i + FETCH_CHUNK_SIZE);
    const { data, error } = await supabase.from(table).select("*").in(pkColumn, chunk);
    if (error) throw error;
    all.push(...(data ?? []));
  }
  return all;
}

// Compare a cloud manifest against the locally-stored ServerUpdatedAt for each
// row. Returns the full set of cloud pks (drives prune) and the subset whose
// full row must be fetched (new locally, or the cloud stamp moved ahead of ours).
function diffManifest(manifest, localTable, localPkColumn) {
  const local = new Map();
  for (const r of db.getAllSync(
    `SELECT ${localPkColumn} AS pk, IFNULL(ServerUpdatedAt, 0) AS sut FROM ${localTable}`,
  )) {
    local.set(r.pk, r.sut);
  }
  const seen = new Set();
  const changedPks = [];
  for (const [pk, cloudSut] of manifest) {
    seen.add(pk);
    const localSut = local.get(pk);
    if (localSut === undefined || cloudSut > localSut) changedPks.push(pk);
  }
  return { seen, changedPks };
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
          has_appt_reminder: !!r.HasApptReminder,
          appt_reminder_status: r.ApptReminderStatus ?? "PENDING",
          report_recipients: JSON.parse(r.ReportRecipients || "[]"),
          calendar_event_id: r.CalendarEventId ?? null,
          calendar_owner_device_id: r.CalendarOwnerDeviceId ?? null,
          calendar_snapshot: snapshotForCloud(r.CalendarSnapshot),
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

// Targeted single-row push for immediacy — e.g. right after marking an inspection
// complete or requesting payment, so the server's state is current without waiting
// for the next syncAll. Mirrors pushInspections' upsert payload + RLS-denied
// handling; like pushInspections it deliberately OMITS the server-owned
// payment_state / report_state / paid columns so the device can't clobber them.
export async function pushInspection(sk) {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return;
    const r = db.getFirstSync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    if (!r) return;
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
        has_appt_reminder: !!r.HasApptReminder,
        appt_reminder_status: r.ApptReminderStatus ?? "PENDING",
        report_recipients: JSON.parse(r.ReportRecipients || "[]"),
        calendar_event_id: r.CalendarEventId ?? null,
        calendar_owner_device_id: r.CalendarOwnerDeviceId ?? null,
        calendar_snapshot: snapshotForCloud(r.CalendarSnapshot),
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
          sk,
        ])
        .catch(() => {});
      logError(e, `sync/pushInspection:rls-denied ${sk}`);
    } else {
      logError(e, `sync/pushInspection:${sk}`);
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
// Tables without _version (SmsTemplate) use UpdatedAt.

async function pullInspections(userId) {
  const manifest = await fetchManifest("inspections", "inspection_sk", userId);
  const { seen, changedPks } = diffManifest(
    manifest,
    "Inspections",
    "InspectionSk",
  );
  if (changedPks.length === 0) return seen;

  const data = await fetchRowsByPks("inspections", "inspection_sk", changedPks);
  const store = useInspectionStore.getState();

  for (const r of data) {
    try {
      const local = db.getFirstSync(
        `SELECT _version, PaymentState, ReportState, Paid FROM Inspections WHERE InspectionSk = ?`,
        [r.inspection_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO Inspections
           (InspectionSk, UserSk, FullName, Summary, AddressLine1, AddressLine2, City, State,
            ZipCode, ScheduledAt, Phone, Email, Longitude, Latitude, Status,
            HasApptReminder, ApptReminderStatus,
            PaymentState, ReportState, Paid, ReportRecipients,
            CalendarEventId, CalendarOwnerDeviceId, CalendarSnapshot,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            r.has_appt_reminder ? 1 : 0,
            r.appt_reminder_status ?? "PENDING",
            r.payment_state ?? "none",
            r.report_state ?? "pending",
            r.paid ? 1 : 0,
            JSON.stringify(r.report_recipients ?? []),
            r.calendar_event_id ?? null,
            r.calendar_owner_device_id ?? null,
            snapshotForLocal(r.calendar_snapshot),
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
      } else {
        // Server-owned rollup columns (payment/report) are authoritative on the
        // cloud — the device never writes them — so sync them on EVERY pull,
        // regardless of the _version gate (which only guards device-owned
        // fields). This recovers a 'requested'/'paid'/'sent' that a _version
        // collision (a device push that rolled _version back) would otherwise
        // strand locally.
        const cloudPay = r.payment_state ?? "none";
        const cloudRep = r.report_state ?? "pending";
        const cloudPaid = r.paid ? 1 : 0;
        if (
          cloudPay !== local.PaymentState ||
          cloudRep !== local.ReportState ||
          cloudPaid !== (local.Paid ?? 0)
        ) {
          await db.runAsync(
            `UPDATE Inspections SET PaymentState=?, ReportState=?, Paid=? WHERE InspectionSk=?`,
            [cloudPay, cloudRep, cloudPaid, r.inspection_sk],
          );
          const curr = useInspectionStore.getState().getById(r.inspection_sk);
          if (curr) {
            useInspectionStore.getState().update({
              ...curr,
              PaymentState: cloudPay,
              ReportState: cloudRep,
              Paid: cloudPaid,
            });
          }
        }

        if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE Inspections SET
           UserSk=?, FullName=?, Summary=?, AddressLine1=?, AddressLine2=?, City=?, State=?,
           ZipCode=?, ScheduledAt=?, Phone=?, Email=?, Longitude=?, Latitude=?, Status=?,
           HasApptReminder=?, ApptReminderStatus=?,
           PaymentState=?, ReportState=?, Paid=?, ReportRecipients=?,
           CalendarEventId=?, CalendarOwnerDeviceId=?, CalendarSnapshot=?,
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
            r.has_appt_reminder ? 1 : 0,
            r.appt_reminder_status ?? "PENDING",
            r.payment_state ?? "none",
            r.report_state ?? "pending",
            r.paid ? 1 : 0,
            JSON.stringify(r.report_recipients ?? []),
            r.calendar_event_id ?? null,
            r.calendar_owner_device_id ?? null,
            snapshotForLocal(r.calendar_snapshot),
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
          // Preserve device-local fields the cloud row doesn't carry
          // (LastReportPath/LastReportAt) so a pull never drops the cached
          // report PDF reference from the in-memory object.
          const prev = useInspectionStore.getState().getById(r.inspection_sk);
          store.update({ ...(prev || {}), ...cloudInspectionToStoreObj(r) });
        }
        }
      }
      // Record that we've reconciled against this server stamp so the row is
      // not re-fetched until the cloud changes it again (also advances a
      // brand-new INSERT off its default 0).
      await db.runAsync(
        `UPDATE Inspections SET ServerUpdatedAt = ? WHERE InspectionSk = ?`,
        [r.server_updated_at ?? 0, r.inspection_sk],
      );
    } catch (e) {
      logError(e, `sync/pullInspections:${r?.inspection_sk ?? "unknown"}`);
    }
  }
  return seen;
}

async function pullSmsTemplates(userId) {
  const manifest = await fetchManifest("sms_templates", "sms_template_sk", userId);
  const { seen, changedPks } = diffManifest(
    manifest,
    "SmsTemplate",
    "SmsTemplateSk",
  );
  if (changedPks.length === 0) return seen;

  const data = await fetchRowsByPks("sms_templates", "sms_template_sk", changedPks);
  for (const r of data) {
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
      await db.runAsync(
        `UPDATE SmsTemplate SET ServerUpdatedAt = ? WHERE SmsTemplateSk = ?`,
        [r.server_updated_at ?? 0, r.sms_template_sk],
      );
    } catch (e) {
      logError(e, `sync/pullSmsTemplates:${r?.sms_template_sk ?? "unknown"}`);
    }
  }
  return seen;
}

async function pullSmsStatus(userId) {
  const manifest = await fetchManifest("sms_status", "sms_status_sk", userId);
  const { seen, changedPks } = diffManifest(manifest, "SmsStatus", "SmsStatusSk");
  if (changedPks.length === 0) return seen;

  const data = await fetchRowsByPks("sms_status", "sms_status_sk", changedPks);
  for (const r of data) {
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
      await db.runAsync(
        `UPDATE SmsStatus SET ServerUpdatedAt = ? WHERE SmsStatusSk = ?`,
        [r.server_updated_at ?? 0, r.sms_status_sk],
      );
    } catch (e) {
      logError(e, `sync/pullSmsStatus:${r?.sms_status_sk ?? "unknown"}`);
    }
  }
  return seen;
}

// ─── WALKTHROUGH FORMS (new model) ──────────────────────────────────────────
// inspection_forms is the 1:1 { schema_snapshot, answers } document that
// replaces inspection_descriptions + inspection_details. Photos live in
// Storage as before; their refs live INSIDE the answers JSON, so the upload
// pass walks the answers rather than a Detail table.

// A photo field's answer is an ARRAY OF OBJECTS (each a PhotoRef). A checkbox
// answer is an array of STRINGS (option ids). That difference is enough to
// tell them apart without consulting the schema.
function looksLikePhotoArray(value) {
  return (
    Array.isArray(value) &&
    value.some((el) => el && typeof el === "object" && "id" in el)
  );
}

// Walk the answers object and upload any photo whose local copy isn't in the
// cloud yet. Mutates each ref in place (sets cloudUri). Returns whether the
// answers changed (so we persist the new cloudUris) and whether any upload is
// still pending (so the row stays dirty and retries instead of being marked
// Synced before its photo actually reached Storage).
async function uploadAnswerPhotos(answers, { orgSk, userId }) {
  let changed = false;
  let pending = false;
  const sections = answers?.sections;
  if (!sections || typeof sections !== "object") return { changed, pending };
  for (const sec of Object.values(sections)) {
    for (const inst of sec?.instances ?? []) {
      const fields = inst?.fields;
      if (!fields || typeof fields !== "object") continue;
      for (const value of Object.values(fields)) {
        if (!looksLikePhotoArray(value)) continue;
        for (const ref of value) {
          if (!ref || typeof ref !== "object") continue;
          if (ref.cloudUri || !ref.localUri) continue;
          if (!orgSk) {
            pending = true;
            continue;
          }
          const uploaded = await uploadInspectionPhoto({
            localUri: ref.localUri,
            orgSk,
            userId,
            detailSk: ref.id,
          });
          if (uploaded) {
            ref.cloudUri = uploaded;
            changed = true;
          } else {
            pending = true; // upload failed — retry next sync
          }
        }
      }
    }
  }
  return { changed, pending };
}

// Push ONE InspectionForm row (the 1:1 walkthrough { schema_snapshot, answers }
// document) to the cloud: upload any pending answer photos, persist their new
// cloudUris locally, then upsert the document. Marks the row Synced unless a
// photo upload is still pending (so it retries on a later sync). Shared by the
// full-sync loop and the single-row pushInspectionForm(sk).
async function pushOneInspectionForm(r, userId, orgSk) {
  try {
    let answers;
    try {
      answers = r.Answers ? JSON.parse(r.Answers) : { sections: {} };
    } catch (_) {
      answers = { sections: {} };
    }
    let schemaSnapshot = null;
    try {
      schemaSnapshot = r.SchemaSnapshot ? JSON.parse(r.SchemaSnapshot) : null;
    } catch (_) {
      schemaSnapshot = null;
    }

    // Upload pending photos first (skip for tombstoned rows). cloudUris
    // written into `answers` get persisted locally so we never re-upload.
    let uploadPending = false;
    if (!r._deleted) {
      const { changed, pending } = await uploadAnswerPhotos(answers, {
        orgSk,
        userId,
      });
      uploadPending = pending;
      if (changed) {
        try {
          await db.runAsync(
            `UPDATE InspectionForm SET Answers = ? WHERE InspectionSk = ?`,
            [JSON.stringify(answers), r.InspectionSk],
          );
        } catch (e) {
          logError(
            e,
            `sync/pushOneInspectionForm:saveCloudUris ${r.InspectionSk}`,
          );
        }
      }
    }

    const { data: up, error } = await supabase
      .from("inspection_forms")
      .upsert(
        {
          inspection_sk: r.InspectionSk,
          user_id: userId,
          template_version: r.TemplateVersion ?? 0,
          schema_snapshot: schemaSnapshot,
          answers,
          _version: r._version ?? 1,
          _last_changed_at: r._lastChangedAt ?? null,
          _deleted: !!r._deleted,
        },
        { onConflict: "inspection_sk" },
      )
      // Read back the trigger-set stamp so the manifest diff doesn't re-download
      // this (potentially large) form on the very next sync.
      .select("server_updated_at");
    if (error) throw error;
    const serverSut = up?.[0]?.server_updated_at ?? null;

    // A row with a still-pending photo stays dirty so the upload retries.
    if (!uploadPending) {
      await db.runAsync(
        `UPDATE InspectionForm SET Synced = 1, ServerUpdatedAt = COALESCE(?, ServerUpdatedAt)
         WHERE InspectionSk = ? AND IFNULL(_lastChangedAt, 0) = ?`,
        [serverSut, r.InspectionSk, r._lastChangedAt ?? 0],
      );
    }
    return { ok: true, pending: uploadPending };
  } catch (e) {
    if (isRlsDenied(e)) {
      await db
        .runAsync(
          `UPDATE InspectionForm SET Synced = 1 WHERE InspectionSk = ?`,
          [r.InspectionSk],
        )
        .catch(() => {});
      logError(e, `sync/pushOneInspectionForm:rls-denied ${r.InspectionSk}`);
    } else {
      logError(e, `sync/pushOneInspectionForm:${r?.InspectionSk ?? "unknown"}`);
    }
    return { ok: false, pending: true };
  }
}

async function pushInspectionForms(userId) {
  const rows = db.getAllSync(`SELECT * FROM InspectionForm WHERE Synced = 0`);
  if (!rows.length) return;
  const orgSk = getOrgSk(userId);
  for (const r of rows) {
    await pushOneInspectionForm(r, userId, orgSk);
  }
}

// Single-row variant called right after marking an inspection complete, so the
// walkthrough answers reach the cloud BEFORE the reconciler asks generate-report
// to render the PDF. Without it, an auto-sent report renders from stale/empty
// cloud answers (header fields present, all sections blank) until the next full
// sync. Pushes regardless of the Synced flag — the cloud copy can lag a
// just-saved edit, and the upsert is idempotent.
export async function pushInspectionForm(sk) {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return;
    const r = db.getFirstSync(
      `SELECT * FROM InspectionForm WHERE InspectionSk = ?`,
      [sk],
    );
    if (!r) return;
    await pushOneInspectionForm(r, userId, getOrgSk(userId));
  } catch (e) {
    logError(e, `sync/pushInspectionForm:${sk}`);
  }
}

async function pullInspectionForms(userId) {
  const manifest = await fetchManifest(
    "inspection_forms",
    "inspection_sk",
    userId,
  );
  const { seen, changedPks } = diffManifest(
    manifest,
    "InspectionForm",
    "InspectionSk",
  );
  if (changedPks.length === 0) return seen;

  const data = await fetchRowsByPks(
    "inspection_forms",
    "inspection_sk",
    changedPks,
  );
  for (const r of data) {
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM InspectionForm WHERE InspectionSk = ?`,
        [r.inspection_sk],
      );
      const answersStr = JSON.stringify(r.answers ?? { sections: {} });
      const schemaStr = r.schema_snapshot
        ? JSON.stringify(r.schema_snapshot)
        : null;
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO InspectionForm
             (InspectionSk, SchemaSnapshot, Answers, TemplateVersion, _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,1)`,
          [
            r.inspection_sk,
            schemaStr,
            answersStr,
            r.template_version ?? 0,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE InspectionForm SET
             SchemaSnapshot=?, Answers=?, TemplateVersion=?, _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionSk=?`,
          [
            schemaStr,
            answersStr,
            r.template_version ?? 0,
            r._version ?? 1,
            r._last_changed_at,
            r._deleted ? 1 : 0,
            r.inspection_sk,
          ],
        );
      }
      await db.runAsync(
        `UPDATE InspectionForm SET ServerUpdatedAt = ? WHERE InspectionSk = ?`,
        [r.server_updated_at ?? 0, r.inspection_sk],
      );
    } catch (e) {
      logError(
        e,
        `sync/pullInspectionForms:${r?.inspection_sk ?? "unknown"}`,
      );
    }
  }
  return seen;
}

// Pull-only: cache the org's PUBLISHED walkthrough template so new
// inspections can snapshot it (Phase 4) and walkthroughs render offline. RLS
// lets any org member SELECT their org's row.
async function pullWalkthroughTemplate(userId) {
  const orgSk = getOrgSk(userId);
  if (!orgSk) return;
  const { data, error } = await supabase
    .from("walkthrough_templates")
    .select("published_schema, published_version")
    .eq("org_sk", orgSk)
    .maybeSingle();
  if (error) throw error;
  if (data?.published_schema) {
    await cacheTemplate(
      orgSk,
      data.published_schema,
      data.published_version ?? 0,
    );
  }
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
      ["pushInspectionForms", () => pushInspectionForms(userId)],
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
    let inspectionFormSks = new Set();
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
        "pullInspectionForms",
        async () => {
          inspectionFormSks = await pullInspectionForms(userId);
        },
      ],
      [
        "pullWalkthroughTemplate",
        async () => {
          await pullWalkthroughTemplate(userId);
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
      // InspectionForm is 1:1 child of Inspections — prune before the parent.
      pruneTable("InspectionForm", "InspectionSk", inspectionFormSks);
      pruneTable("Inspections", "InspectionSk", inspectionSks, (sk) =>
        store.remove(sk),
      );
      pruneTable("SmsStatus", "SmsStatusSk", smsStatusSks);
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
