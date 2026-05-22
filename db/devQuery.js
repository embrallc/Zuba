import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { db, getCurrentDbName } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Raw query runner — accepts any SQL string and optional params array.
// Results print to the Metro/Expo console.
// ─────────────────────────────────────────────────────────────────────────────
export async function devQuery(sql, params = []) {
  try {
    const rows = await db.getAllAsync(sql, params);
    console.log(`\n── devQuery ──────────────────────────`);
    console.log(`SQL: ${sql.trim()}`);
    if (params.length) console.log(`Params:`, params);
    console.log(`Rows (${rows.length}):`);
    rows.forEach((row, i) => console.log(`  [${i}]`, JSON.stringify(row)));
    console.log(`──────────────────────────────────────\n`);
    return rows;
  } catch (e) {
    console.error(`\n── devQuery ERROR ────────────────────`);
    console.error(`SQL: ${sql.trim()}`);
    console.error(e.message);
    console.error(`──────────────────────────────────────\n`);
    return null;
  }
}

export async function wipeDatabase() {
  try {
    console.log("\n── wipeDatabase ──────────────────────");

    // Clear every table in the current user's DB (only if DB is open)
    if (getCurrentDbName()) {
      db.execSync(`
        DELETE FROM SmsStatus;
        DELETE FROM SmsTemplate;
        DELETE FROM InspectionDetail;
        DELETE FROM InspectionDescription;
        DELETE FROM Inspections;
        DELETE FROM SectionTemplate;
        DELETE FROM Users;
        DELETE FROM Organizations;
        DELETE FROM AppLogs;
        DELETE FROM DayCache;
      `);
    }
    await AsyncStorage.removeItem("user_sk");

    // Delete all other per-user DB files (cm_*.db) from the SQLite directory
    const sqliteDir = `${FileSystem.documentDirectory}SQLite/`;
    const currentName = getCurrentDbName();
    try {
      const files = await FileSystem.readDirectoryAsync(sqliteDir);
      const others = files.filter(
        (f) => f.startsWith("cm_") && f.endsWith(".db") && f !== currentName,
      );
      for (const file of others) {
        await FileSystem.deleteAsync(`${sqliteDir}${file}`, {
          idempotent: true,
        });
        await FileSystem.deleteAsync(`${sqliteDir}${file}-wal`, {
          idempotent: true,
        });
        await FileSystem.deleteAsync(`${sqliteDir}${file}-shm`, {
          idempotent: true,
        });
      }
      console.log(`Tables cleared. Removed ${others.length} other DB file(s).`);
    } catch {
      console.log("Tables cleared (SQLite dir not readable or no other DBs).");
    }

    console.log("──────────────────────────────────────\n");
  } catch (e) {
    console.error("── wipeDatabase ERROR ────────────────", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit this function with whatever query you want to run,
// then long-press the menu icon in the top-right of the list screen.
// ─────────────────────────────────────────────────────────────────────────────
export async function runDevQuery() {
  await devQuery("SELECT * FROM Organizations");
}
