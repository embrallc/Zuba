import { db } from "./index";

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

// ─────────────────────────────────────────────────────────────────────────────
// Edit this function with whatever query you want to run,
// then long-press the menu icon in the top-right of the list screen.
// ─────────────────────────────────────────────────────────────────────────────
export async function runDevQuery() {
  await devQuery("SELECT * FROM InspectionDetail");
}
