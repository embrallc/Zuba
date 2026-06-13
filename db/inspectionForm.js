import * as Crypto from "expo-crypto";
import {
  deleteCachedPhoto,
  deleteInspectionPhoto,
  processAndCachePhoto,
} from "../utils/inspectionPhotos";
import { db } from "./index";
import { logError } from "./logs";

// ── InspectionDescription (sections) ──────────────────────────────────────

export async function getDescriptionsByInspection(inspectionSk) {
  try {
    return await db.getAllAsync(
      `SELECT * FROM InspectionDescription
       WHERE InspectionSk = ? AND _deleted = 0
       ORDER BY Position ASC, _lastChangedAt ASC`,
      [inspectionSk],
    );
  } catch (e) {
    logError(
      e,
      `db/inspectionForm.getDescriptionsByInspection sk=${inspectionSk}`,
    );
    throw e;
  }
}

export async function insertDescription(
  inspectionSk,
  description = "",
  position = 0,
  severity = null,
) {
  try {
    const sk = Crypto.randomUUID();
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO InspectionDescription
         (InspectionDescriptionSk, InspectionSk, Description, Position, SeverityLevel, _version, _lastChangedAt, _deleted)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
      [sk, inspectionSk, description, position, severity, now],
    );
    return {
      InspectionDescriptionSk: sk,
      InspectionSk: inspectionSk,
      Description: description,
      Position: position,
      SeverityLevel: severity,
    };
  } catch (e) {
    logError(
      e,
      `db/inspectionForm.insertDescription inspectionSk=${inspectionSk}`,
    );
    throw e;
  }
}

export async function updateSectionPositions(updates) {
  try {
    const now = Date.now();
    for (const { sk, position } of updates) {
      await db.runAsync(
        `UPDATE InspectionDescription
           SET Position = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
         WHERE InspectionDescriptionSk = ?`,
        [position, now, sk],
      );
    }
  } catch (e) {
    logError(e, "db/inspectionForm.updateSectionPositions");
    throw e;
  }
}

export async function updateSectionNotes(sk, notes) {
  try {
    await db.runAsync(
      `UPDATE InspectionDescription
         SET Notes = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDescriptionSk = ?`,
      [notes, Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.updateSectionNotes sk=${sk}`);
    throw e;
  }
}

export async function updateSeverityLevel(sk, level) {
  try {
    await db.runAsync(
      `UPDATE InspectionDescription
         SET SeverityLevel = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDescriptionSk = ?`,
      [level, Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.updateSeverityLevel sk=${sk}`);
    throw e;
  }
}

export async function updateDescription(sk, description) {
  try {
    await db.runAsync(
      `UPDATE InspectionDescription
       SET Description = ?, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDescriptionSk = ?`,
      [description, Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.updateDescription sk=${sk}`);
    throw e;
  }
}

export async function deleteDescription(sk) {
  try {
    const now = Date.now();
    // Capture the section's photos BEFORE tombstoning so their cloud/cache
    // copies can be cleaned up below.
    const details = await db.getAllAsync(
      `SELECT InspectionDetailSk, CloudPictureURI FROM InspectionDetail
       WHERE InspectionDescriptionSk = ? AND _deleted = 0`,
      [sk],
    );
    // Soft-delete the section and every photo attached to it. Two parametered
    // statements so the sk value never participates in SQL string assembly.
    await db.runAsync(
      `UPDATE InspectionDescription
         SET _deleted = 1, _version = _version + 1, Synced = 0, _lastChangedAt = ?
       WHERE InspectionDescriptionSk = ?`,
      [now, sk],
    );
    await db.runAsync(
      `UPDATE InspectionDetail
         SET _deleted = 1, _version = _version + 1, Synced = 0, _lastChangedAt = ?
       WHERE InspectionDescriptionSk = ?`,
      [now, sk],
    );
    // Fire-and-forget: the rows are already tombstoned; storage cleanup is
    // best-effort (a missed object only costs storage, never correctness).
    for (const d of details ?? []) {
      if (d.CloudPictureURI) deleteInspectionPhoto(d.CloudPictureURI);
      deleteCachedPhoto(d.InspectionDetailSk);
    }
  } catch (e) {
    logError(e, `db/inspectionForm.deleteDescription sk=${sk}`);
    throw e;
  }
}

// ── InspectionDetail (pictures + notes) ───────────────────────────────────

export async function getDetailsByDescription(descriptionSk) {
  try {
    return await db.getAllAsync(
      `SELECT * FROM InspectionDetail
       WHERE InspectionDescriptionSk = ? AND _deleted = 0
       ORDER BY _lastChangedAt ASC`,
      [descriptionSk],
    );
  } catch (e) {
    logError(
      e,
      `db/inspectionForm.getDetailsByDescription sk=${descriptionSk}`,
    );
    throw e;
  }
}

export async function insertDetail(
  descriptionSk,
  { sk: providedSk, localPictureURI, cloudPictureURI } = {},
) {
  try {
    const sk = providedSk ?? Crypto.randomUUID();
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO InspectionDetail
         (InspectionDetailSk, InspectionDescriptionSk, LocalPictureURI, CloudPictureURI, PictureNote, PictureMarkup, _version, _lastChangedAt, _deleted)
       VALUES (?, ?, ?, ?, '', NULL, 1, ?, 0)`,
      [
        sk,
        descriptionSk,
        localPictureURI ?? null,
        cloudPictureURI ?? null,
        now,
      ],
    );
    return {
      InspectionDetailSk: sk,
      InspectionDescriptionSk: descriptionSk,
      LocalPictureURI: localPictureURI ?? null,
      CloudPictureURI: cloudPictureURI ?? null,
      PictureNote: "",
      PictureMarkup: null,
    };
  } catch (e) {
    logError(e, `db/inspectionForm.insertDetail descSk=${descriptionSk}`);
    throw e;
  }
}

// User just added a photo. Downscale + JPEG it into the app CACHE (never the
// user's Photos library — the cloud bucket is the durable copy), then insert
// the detail row with the cache path and Synced=0. The cloud upload is
// deferred to the next syncAll — pushInspectionDetails sees LocalPictureURI
// set with no CloudPictureURI and uploads the already-processed file.
export async function addInspectionPhoto({ descriptionSk, sourceUri }) {
  try {
    if (!descriptionSk || !sourceUri) return null;

    // sk minted up front so the cache file can be named after it.
    const sk = Crypto.randomUUID();
    const cachePath = await processAndCachePhoto(sourceUri, sk);

    // If processing failed, fall back to the raw temp URI — it may survive
    // long enough for the next sync's upload pass to rescue it.
    return await insertDetail(descriptionSk, {
      sk,
      localPictureURI: cachePath ?? sourceUri,
    });
  } catch (e) {
    logError(e, `db/inspectionForm.addInspectionPhoto descSk=${descriptionSk}`);
    return null;
  }
}

// Sets CloudPictureURI after a successful Storage upload. Does not touch
// Synced — the caller (sync.js) handles that as part of the row push.
export async function setCloudPictureURI(sk, cloudPictureURI) {
  try {
    if (!sk) return;
    await db.runAsync(
      `UPDATE InspectionDetail SET CloudPictureURI = ? WHERE InspectionDetailSk = ?`,
      [cloudPictureURI ?? null, sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.setCloudPictureURI sk=${sk}`);
  }
}

// Patch-style: only the fields actually present in `fields` are written, so
// a markup-only save (photoedit) can never null out the note (photonote) and
// vice versa.
export async function updateDetail(sk, fields = {}) {
  try {
    const sets = [];
    const args = [];
    if ("pictureNote" in fields) {
      sets.push("PictureNote = ?");
      args.push(fields.pictureNote ?? null);
    }
    if ("pictureMarkup" in fields) {
      sets.push("PictureMarkup = ?");
      args.push(fields.pictureMarkup ?? null);
    }
    if (!sets.length) return;
    args.push(Date.now(), sk);
    await db.runAsync(
      `UPDATE InspectionDetail
       SET ${sets.join(", ")}, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDetailSk = ?`,
      args,
    );
  } catch (e) {
    logError(e, `db/inspectionForm.updateDetail sk=${sk}`);
    throw e;
  }
}

export async function deleteDetail(sk) {
  try {
    const row = await db.getFirstAsync(
      `SELECT CloudPictureURI FROM InspectionDetail WHERE InspectionDetailSk = ?`,
      [sk],
    );
    await db.runAsync(
      `UPDATE InspectionDetail
         SET _deleted = 1, _version = _version + 1, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDetailSk = ?`,
      [Date.now(), sk],
    );
    // Best-effort cleanup of the cloud + cache copies (fire-and-forget).
    if (row?.CloudPictureURI) deleteInspectionPhoto(row.CloudPictureURI);
    deleteCachedPhoto(sk);
  } catch (e) {
    logError(e, `db/inspectionForm.deleteDetail sk=${sk}`);
    throw e;
  }
}
