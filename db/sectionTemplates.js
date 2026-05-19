import * as Crypto from "expo-crypto";
import { db } from "./index";
import { logError } from "./logs";

export async function getSectionTemplates(userSk) {
  try {
    return await db.getAllAsync(
      `SELECT * FROM SectionTemplate WHERE UserSk = ? ORDER BY Position ASC`,
      [userSk],
    );
  } catch (e) {
    logError(e, `db/sectionTemplates.getSectionTemplates userSk=${userSk}`);
    throw e;
  }
}

export async function insertSectionTemplate(userSk, name, position) {
  try {
    const sk = Crypto.randomUUID();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO SectionTemplate (SectionTemplateSk, UserSk, Name, Position, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sk, userSk, name, position, now, now],
    );
    return { SectionTemplateSk: sk, UserSk: userSk, Name: name, Position: position };
  } catch (e) {
    logError(e, "db/sectionTemplates.insertSectionTemplate");
    throw e;
  }
}

export async function updateSectionTemplateName(sk, name) {
  try {
    await db.runAsync(
      `UPDATE SectionTemplate SET Name = ?, UpdatedAt = ?, Synced = 0 WHERE SectionTemplateSk = ?`,
      [name, new Date().toISOString(), sk],
    );
  } catch (e) {
    logError(e, `db/sectionTemplates.updateSectionTemplateName sk=${sk}`);
    throw e;
  }
}

export async function deleteSectionTemplate(sk) {
  try {
    await db.runAsync(
      `DELETE FROM SectionTemplate WHERE SectionTemplateSk = ?`,
      [sk],
    );
  } catch (e) {
    logError(e, `db/sectionTemplates.deleteSectionTemplate sk=${sk}`);
    throw e;
  }
}

export async function reorderSectionTemplates(updates) {
  try {
    const now = new Date().toISOString();
    for (const { sk, position } of updates) {
      await db.runAsync(
        `UPDATE SectionTemplate SET Position = ?, UpdatedAt = ?, Synced = 0 WHERE SectionTemplateSk = ?`,
        [position, now, sk],
      );
    }
  } catch (e) {
    logError(e, "db/sectionTemplates.reorderSectionTemplates");
    throw e;
  }
}
