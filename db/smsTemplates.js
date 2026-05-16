import dayjs from "dayjs";
import { randomUUID } from "expo-crypto";
import { db } from "./index";
import { logError } from "./logs";

export async function getSmsTemplates(userSk) {
  try {
    return await db.getAllAsync(
      "SELECT * FROM SmsTemplate WHERE UserSk = ? ORDER BY Position ASC",
      [userSk],
    );
  } catch (e) {
    logError(e, "getSmsTemplates");
    return [];
  }
}

export async function insertSmsTemplate(userSk, name, body, position) {
  try {
    const sk = randomUUID();
    const now = dayjs().toISOString();
    await db.runAsync(
      `INSERT INTO SmsTemplate (SmsTemplateSk, UserSk, Name, Body, Position, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sk, userSk, name, body, position, now, now],
    );
    return {
      SmsTemplateSk: sk,
      UserSk: userSk,
      Name: name,
      Body: body,
      Position: position,
      CreatedAt: now,
      UpdatedAt: now,
    };
  } catch (e) {
    logError(e, `db/smsTemplates.insertSmsTemplate userSk=${userSk}`);
    throw e;
  }
}

export async function updateSmsTemplate(sk, name, body) {
  try {
    const now = dayjs().toISOString();
    await db.runAsync(
      "UPDATE SmsTemplate SET Name = ?, Body = ?, UpdatedAt = ? WHERE SmsTemplateSk = ?",
      [name, body, now, sk],
    );
  } catch (e) {
    logError(e, `db/smsTemplates.updateSmsTemplate sk=${sk}`);
    throw e;
  }
}

export async function deleteSmsTemplate(sk) {
  try {
    await db.runAsync("DELETE FROM SmsTemplate WHERE SmsTemplateSk = ?", [sk]);
  } catch (e) {
    logError(e, `db/smsTemplates.deleteSmsTemplate sk=${sk}`);
    throw e;
  }
}
