import { useInspectionStore } from '../stores/useInspectionStore';
import { supabase } from './supabase';
import { db } from '../db/index';
import { logError } from '../db/logs';

function cloudInspectionToStoreObj(r) {
  return {
    InspectionSk:  r.inspection_sk,
    UserSk:        r.user_id,
    FullName:      r.full_name ?? null,
    Summary:       r.summary ?? null,
    AddressLine1:  r.address_line1 ?? null,
    AddressLine2:  r.address_line2 ?? null,
    City:          r.city ?? null,
    State:         r.state ?? null,
    ZipCode:       r.zip_code ?? null,
    ScheduledAt:   r.scheduled_at ?? null,
    Phone:         r.phone ?? null,
    Email:         r.email ?? null,
    Longitude:     r.longitude ?? null,
    Latitude:      r.latitude ?? null,
    Status:        r.status ?? 'OPEN',
    _version:      r._version ?? 1,
    _lastChangedAt: r._last_changed_at ?? null,
    _deleted:      r._deleted ? 1 : 0,
    Synced:        1,
  };
}

// ─── PUSH ─────────────────────────────────────────────────────────────────────
// For each table: query Synced = 0, upsert to Supabase, mark Synced = 1 on success.
// user_id is the Supabase auth UID (session.user.id) — required for cloud RLS.

async function pushInspections(userId) {
  const rows = db.getAllSync(`SELECT * FROM Inspections WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('inspections').upsert(
    rows.map(r => ({
      inspection_sk:    r.InspectionSk,
      user_id:          userId,
      full_name:        r.FullName ?? null,
      summary:          r.Summary ?? null,
      address_line1:    r.AddressLine1 ?? null,
      address_line2:    r.AddressLine2 ?? null,
      city:             r.City ?? null,
      state:            r.State ?? null,
      zip_code:         r.ZipCode ?? null,
      scheduled_at:     r.ScheduledAt ?? null,
      phone:            r.Phone ?? null,
      email:            r.Email ?? null,
      longitude:        r.Longitude ?? null,
      latitude:         r.Latitude ?? null,
      status:           r.Status ?? 'OPEN',
      _version:         r._version ?? 1,
      _last_changed_at: r._lastChangedAt ?? null,
      _deleted:         !!r._deleted,
    })),
    { onConflict: 'inspection_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE Inspections SET Synced = 1 WHERE InspectionSk IN (${ph})`,
    rows.map(r => r.InspectionSk),
  );
}

async function pushInspectionDescriptions(userId) {
  const rows = db.getAllSync(`SELECT * FROM InspectionDescription WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('inspection_descriptions').upsert(
    rows.map(r => ({
      inspection_description_sk: r.InspectionDescriptionSk,
      inspection_sk:             r.InspectionSk,
      user_id:                   userId,
      description:               r.Description ?? null,
      notes:                     r.Notes ?? null,
      position:                  r.Position ?? 0,
      severity_level:            r.SeverityLevel ?? null,
      _version:                  r._version ?? 1,
      _last_changed_at:          r._lastChangedAt ?? null,
      _deleted:                  !!r._deleted,
    })),
    { onConflict: 'inspection_description_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE InspectionDescription SET Synced = 1 WHERE InspectionDescriptionSk IN (${ph})`,
    rows.map(r => r.InspectionDescriptionSk),
  );
}

async function pushInspectionDetails(userId) {
  const rows = db.getAllSync(`SELECT * FROM InspectionDetail WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('inspection_details').upsert(
    rows.map(r => ({
      inspection_detail_sk:      r.InspectionDetailSk,
      inspection_description_sk: r.InspectionDescriptionSk,
      user_id:                   userId,
      picture_uri:               r.PictureURI ?? null,
      picture_note:              r.PictureNote ?? null,
      picture_markup:            r.PictureMarkup ?? null,
      _version:                  r._version ?? 1,
      _last_changed_at:          r._lastChangedAt ?? null,
      _deleted:                  !!r._deleted,
    })),
    { onConflict: 'inspection_detail_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE InspectionDetail SET Synced = 1 WHERE InspectionDetailSk IN (${ph})`,
    rows.map(r => r.InspectionDetailSk),
  );
}

async function pushSectionTemplates(userId) {
  const rows = db.getAllSync(`SELECT * FROM SectionTemplate WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('section_templates').upsert(
    rows.map(r => ({
      section_template_sk: r.SectionTemplateSk,
      user_id:             userId,
      name:                r.Name,
      position:            r.Position ?? 0,
      created_at:          r.CreatedAt,
      updated_at:          r.UpdatedAt,
    })),
    { onConflict: 'section_template_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE SectionTemplate SET Synced = 1 WHERE SectionTemplateSk IN (${ph})`,
    rows.map(r => r.SectionTemplateSk),
  );
}

async function pushSmsTemplates(userId) {
  const rows = db.getAllSync(`SELECT * FROM SmsTemplate WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('sms_templates').upsert(
    rows.map(r => ({
      sms_template_sk: r.SmsTemplateSk,
      user_id:         userId,
      name:            r.Name,
      body:            r.Body,
      position:        r.Position ?? 0,
      created_at:      r.CreatedAt,
      updated_at:      r.UpdatedAt,
    })),
    { onConflict: 'sms_template_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE SmsTemplate SET Synced = 1 WHERE SmsTemplateSk IN (${ph})`,
    rows.map(r => r.SmsTemplateSk),
  );
}

async function pushSmsStatus(userId) {
  const rows = db.getAllSync(`SELECT * FROM SmsStatus WHERE Synced = 0`);
  if (!rows.length) return;

  const { error } = await supabase.from('sms_status').upsert(
    rows.map(r => ({
      sms_status_sk:    r.SmsStatusSk,
      user_id:          userId,
      inspection_sk:    r.InspectionSk,
      sms_template_sk:  r.SmsTemplateSk,
      sent:             !!r.Sent,
      sent_at:          r.SentAt ?? null,
      _version:         r._version ?? 1,
      _last_changed_at: r._lastChangedAt ?? null,
      _deleted:         !!r._deleted,
    })),
    { onConflict: 'sms_status_sk' },
  );
  if (error) throw error;

  const ph = rows.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE SmsStatus SET Synced = 1 WHERE SmsStatusSk IN (${ph})`,
    rows.map(r => r.SmsStatusSk),
  );
}

// ─── PULL ─────────────────────────────────────────────────────────────────────
// RLS on every table ensures each select returns only rows the user can see.
// Conflict rule: if cloud _version > local _version → update local.
// Tables without _version (SectionTemplate, SmsTemplate) use UpdatedAt.
// Per-row try/catch so a single FK violation doesn't abort the whole pull.

async function pullInspections() {
  const { data, error } = await supabase.from('inspections').select('*');
  if (error) throw error;
  if (!data?.length) return;

  const store = useInspectionStore.getState();

  for (const r of data) {
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
            r.inspection_sk, r.user_id, r.full_name, r.summary,
            r.address_line1, r.address_line2, r.city, r.state, r.zip_code,
            r.scheduled_at, r.phone, r.email, r.longitude, r.latitude,
            r.status ?? 'OPEN', r._version ?? 1, r._last_changed_at,
            r._deleted ? 1 : 0, 1,
          ],
        );
        if (!r._deleted) {
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
            r.user_id, r.full_name, r.summary, r.address_line1, r.address_line2,
            r.city, r.state, r.zip_code, r.scheduled_at, r.phone, r.email,
            r.longitude, r.latitude, r.status ?? 'OPEN',
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, r.inspection_sk,
          ],
        );
        if (r._deleted) {
          store.remove(r.inspection_sk);
        } else {
          store.update(cloudInspectionToStoreObj(r));
        }
      }
    } catch (e) {
      logError(e, `sync/pullInspections:${r.inspection_sk}`);
    }
  }
}

async function pullInspectionDescriptions() {
  const { data, error } = await supabase.from('inspection_descriptions').select('*');
  if (error) throw error;
  if (!data?.length) return;

  for (const r of data) {
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
            r.inspection_description_sk, r.inspection_sk, r.description, r.notes,
            r.position ?? 0, r.severity_level ?? null,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, 1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE InspectionDescription SET
           InspectionSk=?, Description=?, Notes=?, Position=?, SeverityLevel=?,
           _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionDescriptionSk=?`,
          [
            r.inspection_sk, r.description, r.notes, r.position ?? 0, r.severity_level ?? null,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, r.inspection_description_sk,
          ],
        );
      }
    } catch (e) {
      logError(e, `sync/pullInspectionDescriptions:${r.inspection_description_sk}`);
    }
  }
}

async function pullInspectionDetails() {
  const { data, error } = await supabase.from('inspection_details').select('*');
  if (error) throw error;
  if (!data?.length) return;

  for (const r of data) {
    try {
      const local = db.getFirstSync(
        `SELECT _version FROM InspectionDetail WHERE InspectionDetailSk = ?`,
        [r.inspection_detail_sk],
      );
      if (!local) {
        await db.runAsync(
          `INSERT OR IGNORE INTO InspectionDetail
           (InspectionDetailSk, InspectionDescriptionSk, PictureURI, PictureNote, PictureMarkup,
            _version, _lastChangedAt, _deleted, Synced)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            r.inspection_detail_sk, r.inspection_description_sk,
            r.picture_uri ?? null, r.picture_note ?? null, r.picture_markup ?? null,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, 1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE InspectionDetail SET
           InspectionDescriptionSk=?, PictureURI=?, PictureNote=?, PictureMarkup=?,
           _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE InspectionDetailSk=?`,
          [
            r.inspection_description_sk, r.picture_uri, r.picture_note, r.picture_markup,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, r.inspection_detail_sk,
          ],
        );
      }
    } catch (e) {
      logError(e, `sync/pullInspectionDetails:${r.inspection_detail_sk}`);
    }
  }
}

async function pullSectionTemplates() {
  const { data, error } = await supabase.from('section_templates').select('*');
  if (error) throw error;
  if (!data?.length) return;

  for (const r of data) {
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
            r.section_template_sk, r.user_id, r.name, r.position ?? 0,
            r.created_at, r.updated_at, 1,
          ],
        );
      } else if (r.updated_at > local.UpdatedAt) {
        await db.runAsync(
          `UPDATE SectionTemplate SET Name=?, Position=?, UpdatedAt=?, Synced=1
           WHERE SectionTemplateSk=?`,
          [r.name, r.position ?? 0, r.updated_at, r.section_template_sk],
        );
      }
    } catch (e) {
      logError(e, `sync/pullSectionTemplates:${r.section_template_sk}`);
    }
  }
}

async function pullSmsTemplates() {
  const { data, error } = await supabase.from('sms_templates').select('*');
  if (error) throw error;
  if (!data?.length) return;

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
            r.sms_template_sk, r.user_id, r.name, r.body, r.position ?? 0,
            r.created_at, r.updated_at, 1,
          ],
        );
      } else if (r.updated_at > local.UpdatedAt) {
        await db.runAsync(
          `UPDATE SmsTemplate SET Name=?, Body=?, Position=?, UpdatedAt=?, Synced=1
           WHERE SmsTemplateSk=?`,
          [r.name, r.body, r.position ?? 0, r.updated_at, r.sms_template_sk],
        );
      }
    } catch (e) {
      logError(e, `sync/pullSmsTemplates:${r.sms_template_sk}`);
    }
  }
}

async function pullSmsStatus() {
  const { data, error } = await supabase.from('sms_status').select('*');
  if (error) throw error;
  if (!data?.length) return;

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
            r.sms_status_sk, r.user_id, r.inspection_sk, r.sms_template_sk,
            r.sent ? 1 : 0, r.sent_at ?? null,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, 1,
          ],
        );
      } else if ((r._version ?? 1) > (local._version ?? 1)) {
        await db.runAsync(
          `UPDATE SmsStatus SET
           Sent=?, SentAt=?, _version=?, _lastChangedAt=?, _deleted=?, Synced=1
           WHERE SmsStatusSk=?`,
          [
            r.sent ? 1 : 0, r.sent_at ?? null,
            r._version ?? 1, r._last_changed_at, r._deleted ? 1 : 0, r.sms_status_sk,
          ],
        );
      }
    } catch (e) {
      logError(e, `sync/pullSmsStatus:${r.sms_status_sk}`);
    }
  }
}

// ─── TARGETED PUSH ───────────────────────────────────────────────────────────
// Call after individual mutations so the cloud is updated immediately without
// waiting for the next full syncAll.

export async function pushInspection(sk) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return;
    const userId = session.user.id;

    const row = db.getFirstSync(
      `SELECT * FROM Inspections WHERE InspectionSk = ?`,
      [sk],
    );
    if (!row) return;

    const { error } = await supabase.from('inspections').upsert(
      {
        inspection_sk:    row.InspectionSk,
        user_id:          userId,
        full_name:        row.FullName ?? null,
        summary:          row.Summary ?? null,
        address_line1:    row.AddressLine1 ?? null,
        address_line2:    row.AddressLine2 ?? null,
        city:             row.City ?? null,
        state:            row.State ?? null,
        zip_code:         row.ZipCode ?? null,
        scheduled_at:     row.ScheduledAt ?? null,
        phone:            row.Phone ?? null,
        email:            row.Email ?? null,
        longitude:        row.Longitude ?? null,
        latitude:         row.Latitude ?? null,
        status:           row.Status ?? 'OPEN',
        _version:         row._version ?? 1,
        _last_changed_at: row._lastChangedAt ?? null,
        _deleted:         !!row._deleted,
      },
      { onConflict: 'inspection_sk' },
    );
    if (error) throw error;

    await db.runAsync(
      `UPDATE Inspections SET Synced = 1 WHERE InspectionSk = ?`,
      [sk],
    );
  } catch (e) {
    logError(e, `sync/pushInspection:${sk}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
// Call on app open (after auth check) and after login.
// Fire-and-forget: caller does not need to await.

export async function syncAll() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return;
    const userId = session.user.id;

    // Push phase — push local changes to cloud before pulling
    // FK order: parent tables before children
    const pushSteps = [
      ['pushInspections',            () => pushInspections(userId)],
      ['pushInspectionDescriptions', () => pushInspectionDescriptions(userId)],
      ['pushInspectionDetails',      () => pushInspectionDetails(userId)],
      ['pushSectionTemplates',       () => pushSectionTemplates(userId)],
      ['pushSmsTemplates',           () => pushSmsTemplates(userId)],
      ['pushSmsStatus',              () => pushSmsStatus(userId)],
    ];
    for (const [name, fn] of pushSteps) {
      try {
        await fn();
      } catch (e) {
        logError(e, `sync/${name}`);
      }
    }

    // Pull phase — bring down anything missing or newer on cloud
    // Same FK order so parent rows exist before child inserts
    const pullSteps = [
      ['pullInspections',            pullInspections],
      ['pullInspectionDescriptions', pullInspectionDescriptions],
      ['pullInspectionDetails',      pullInspectionDetails],
      ['pullSectionTemplates',       pullSectionTemplates],
      ['pullSmsTemplates',           pullSmsTemplates],
      ['pullSmsStatus',              pullSmsStatus],
    ];
    for (const [name, fn] of pullSteps) {
      try {
        await fn();
      } catch (e) {
        logError(e, `sync/${name}`);
      }
    }
  } catch (e) {
    logError(e, 'sync/syncAll');
  }
}
