// Client mirror of the server's channelRecipients() (_shared/email.ts): resolve
// which addresses receive the REPORT for an inspection, so a manually shared
// report targets exactly the same people as the automatic send.
//
// inspection.ReportRecipients is stored as a JSON string (SQLite TEXT) in one of
// two shapes:
//   - NEW per-channel object form: { report: string[], invoice: string[] }
//   - LEGACY array form: [{ email, label }] | string[] (everyone got the report)

// Trim + basic-shape filter + case-insensitive dedupe, preserving first-seen
// order and original casing (nicer in a To field; delivery is case-insensitive).
function validEmails(list) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const s = typeof e === "string" ? e.trim() : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Every address that should receive the REPORT, matching the server's auto-send
// selection. NEW object form → exactly the `report` channel. Legacy/none →
// everyone in the list plus the primary email. Null-safe (returns []).
export function collectReportRecipients(inspection) {
  if (!inspection) return [];
  let rr = null;
  try {
    rr = inspection.ReportRecipients ? JSON.parse(inspection.ReportRecipients) : null;
  } catch (_) {
    rr = null;
  }
  if (rr && typeof rr === "object" && !Array.isArray(rr)) {
    return validEmails(rr.report);
  }
  const legacy = Array.isArray(rr)
    ? rr.map((r) => (typeof r === "string" ? r : r?.email))
    : [];
  return validEmails([...legacy, inspection.Email]);
}
