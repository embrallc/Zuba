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
}

export async function updateSmsTemplate(sk, name, body) {
  const now = dayjs().toISOString();
  await db.runAsync(
    "UPDATE SmsTemplate SET Name = ?, Body = ?, UpdatedAt = ? WHERE SmsTemplateSk = ?",
    [name, body, now, sk],
  );
}

export async function deleteSmsTemplate(sk) {
  await db.runAsync("DELETE FROM SmsTemplate WHERE SmsTemplateSk = ?", [sk]);
}
