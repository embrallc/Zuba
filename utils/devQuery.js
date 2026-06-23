import { db } from "../db/index";

/**
 * Development only — run any SQL query and print results to the console.
 *
 * Usage (anywhere in the app):
 *   import { devQuery } from "../utils/devQuery";
 *   devQuery("SELECT * FROM InspectionForm WHERE _deleted = 0");
 *   devQuery("SELECT * FROM Inspections WHERE InspectionSk = ?", ["some-uuid"]);
 */
export async function devQuery(sql, params = []) {
  try {
    const rows = await db.getAllAsync(sql, params);
    console.log(`\n── devQuery ──────────────────────────`);
    console.log(`SQL: ${sql}`);
    if (params.length) console.log(`Params: ${JSON.stringify(params)}`);
    console.log(`Rows (${rows.length}):`);
    rows.forEach((row, i) => console.log(`  [${i}]`, JSON.stringify(row)));
    console.log(`──────────────────────────────────────\n`);
    return rows;
  } catch (e) {
    console.error(`\n── devQuery ERROR ────────────────────`);
    console.error(`SQL: ${sql}`);
    console.error(e.message);
    console.error(`──────────────────────────────────────\n`);
    return null;
  }
}
