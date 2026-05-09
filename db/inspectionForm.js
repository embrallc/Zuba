import * as Crypto from "expo-crypto";
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

export async function insertDescription(inspectionSk, description = "", position = 0, severity = null) {
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
        `UPDATE InspectionDescription SET Position = ?, _lastChangedAt = ? WHERE InspectionDescriptionSk = ?`,
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
      `UPDATE InspectionDescription SET Notes = ?, _lastChangedAt = ? WHERE InspectionDescriptionSk = ?`,
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
      `UPDATE InspectionDescription SET SeverityLevel = ?, _lastChangedAt = ? WHERE InspectionDescriptionSk = ?`,
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
       SET Description = ?, _lastChangedAt = ?
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
    // Soft-delete section and all its pictures in one transaction
    await db.execAsync(`
      UPDATE InspectionDescription SET _deleted = 1, _lastChangedAt = ${now}
        WHERE InspectionDescriptionSk = '${sk}';
      UPDATE InspectionDetail SET _deleted = 1, _lastChangedAt = ${now}
        WHERE InspectionDescriptionSk = '${sk}';
    `);
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

export async function insertDetail(descriptionSk, { pictureURI }) {
  try {
    const sk = Crypto.randomUUID();
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO InspectionDetail
         (InspectionDetailSk, InspectionDescriptionSk, PictureURI, PictureNote, PictureMarkup, _version, _lastChangedAt, _deleted)
       VALUES (?, ?, ?, '', NULL, 1, ?, 0)`,
      [sk, descriptionSk, pictureURI, now],
    );
    return {
      InspectionDetailSk: sk,
      InspectionDescriptionSk: descriptionSk,
      PictureURI: pictureURI,
      PictureNote: "",
      PictureMarkup: null,
    };
  } catch (e) {
    logError(e, `db/inspectionForm.insertDetail descSk=${descriptionSk}`);
    throw e;
  }
}

export async function updateDetail(sk, { pictureNote, pictureMarkup }) {
  try {
    await db.runAsync(
      `UPDATE InspectionDetail
       SET PictureNote = ?, PictureMarkup = ?, _lastChangedAt = ?
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
      `UPDATE InspectionDetail SET _deleted = 1, _lastChangedAt = ? WHERE InspectionDetailSk = ?`,
      [Date.now(), sk],
    );
  } catch (e) {
    logError(e, `db/inspectionForm.deleteDetail sk=${sk}`);
    throw e;
  }
}
