import * as Crypto from "expo-crypto";
import { saveToPhotoLibrary } from "../utils/inspectionPhotos";
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
        `UPDATE InspectionDescription SET Position = ?, _lastChangedAt = ?, Synced = 0 WHERE InspectionDescriptionSk = ?`,
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
      `UPDATE InspectionDescription SET Notes = ?, _lastChangedAt = ?, Synced = 0 WHERE InspectionDescriptionSk = ?`,
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
      `UPDATE InspectionDescription SET SeverityLevel = ?, _lastChangedAt = ?, Synced = 0 WHERE InspectionDescriptionSk = ?`,
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
       SET Description = ?, _lastChangedAt = ?, Synced = 0
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
    // Soft-delete the section and every photo attached to it. Two parametered
    // statements so the sk value never participates in SQL string assembly.
    await db.runAsync(
      `UPDATE InspectionDescription
         SET _deleted = 1, Synced = 0, _lastChangedAt = ?
       WHERE InspectionDescriptionSk = ?`,
      [now, sk],
    );
    await db.runAsync(
      `UPDATE InspectionDetail
         SET _deleted = 1, Synced = 0, _lastChangedAt = ?
       WHERE InspectionDescriptionSk = ?`,
      [now, sk],
    );
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

// User just added a photo. Save into the user's Photos library so they own
// it, then insert the detail row with the asset id and Synced=0. The cloud
// upload is deferred to the next syncAll — pushInspectionDetails will see
// LocalPictureURI set with no CloudPictureURI and upload it then.
//
// Pass `assetId` if the caller already has one (e.g. ImagePicker returns it
// when a photo is selected from the library, or the in-app camera saved
// during capture) to skip the library save step.
export async function addInspectionPhoto({
  descriptionSk,
  sourceUri,
  assetId: providedAssetId,
}) {
  try {
    if (!descriptionSk) return null;
    if (!sourceUri && !providedAssetId) return null;

    const assetId =
      providedAssetId ??
      (sourceUri ? await saveToPhotoLibrary(sourceUri) : null);

    return await insertDetail(descriptionSk, {
      localPictureURI: assetId,
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

export async function updateDetail(sk, { pictureNote, pictureMarkup }) {
  try {
    await db.runAsync(
      `UPDATE InspectionDetail
       SET PictureNote = ?, PictureMarkup = ?, _lastChangedAt = ?, Synced = 0
       WHERE InspectionDetailSk = ?`,
      [pictureNote ?? null, pictureMarkup ?? null, Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.updateDetail sk=${sk}`);
    throw e;
  }
}

export async function deleteDetail(sk) {
  try {
    await db.runAsync(
      `UPDATE InspectionDetail SET _deleted = 1, _lastChangedAt = ?, Synced = 0 WHERE InspectionDetailSk = ?`,
      [Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.deleteDetail sk=${sk}`);
    throw e;
  }
}
