// tools — the methods behind the MCP tools registered in zanbiMcp.ts.
//
// ZanbiMcp.buildServer passes in the service-role client and the Caller it
// worked out from the connection key. RLS doesn't apply to that client, so
// every query here MUST filter to caller.userId.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import dayjs from "npm:dayjs@1.11.23";
import customParseFormat from "npm:dayjs@1.11.23/plugin/customParseFormat.js";
import utc from "npm:dayjs@1.11.23/plugin/utc.js";
import timezone from "npm:dayjs@1.11.23/plugin/timezone.js";

// Day.js plugins: strict format parsing, and timezone-aware dates (timezone
// needs utc).
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

// Who is calling. Built once per request in ZanbiMcp.buildServer from the
// connection key, never from the AI's input.
export type Caller = {
  userId: string;
  orgSk: string | null; // for org-level data; inspection reads still filter by userId
  timeZone: string; // the org's timezone, America/Chicago if it has none
};

// Longest range one call can ask for, so a single call can't pull the whole
// schedule. The tool's description tells the AI to split longer ranges.
export const MAX_RANGE_DAYS = 31;

export async function getInspectionsByDate(
  supabase: SupabaseClient,
  caller: Caller,
  startDate: string,
  endDate: string,
) {
  // Strict parse (the `true`): each string must be exactly YYYY-MM-DD and a
  // real day, so "2026-02-30" and "tomorrow" both fail.
  const startDay = dayjs(startDate, "YYYY-MM-DD", true);
  const endDay = dayjs(endDate, "YYYY-MM-DD", true);
  if (!startDay.isValid() || !endDay.isValid()) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Wrong date format, must be YYYY-MM-DD." },
      ],
    };
  }

  // The filters below are ANDed, so a reversed range would quietly match
  // nothing and the AI would report "no inspections". Say what's wrong.
  if (endDay.isBefore(startDay)) {
    return {
      isError: true,
      content: [
        { type: "text", text: "endDate must be the same as or after startDate." },
      ],
    };
  }

  // Both days count, so Oct 1 through Oct 31 is 31 days.
  if (endDay.diff(startDay, "day") + 1 > MAX_RANGE_DAYS) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Date range too long: at most ${MAX_RANGE_DAYS} days per call. Split it into smaller ranges.`,
        },
      ],
    };
  }

  // scheduled_at is a timestamp, so it can't equal a date directly — match
  // everything from local midnight on startDate up to local midnight after
  // endDate, which makes endDate inclusive. "Local" means the org's
  // timezone, not UTC (8pm in Chicago is already tomorrow in UTC). Day.js
  // handles the 23h/25h daylight-saving days.
  const rangeStart = dayjs.tz(startDate, caller.timeZone);
  const rangeEnd = dayjs.tz(endDate, caller.timeZone).add(1, "day");
  const { data, error } = await supabase
    .from("inspections")
    .select("full_name, address_line1, city, zip_code, scheduled_at")
    .eq("user_id", caller.userId)
    .not("_deleted", "is", true)
    .gte("scheduled_at", rangeStart.toISOString())
    .lt("scheduled_at", rangeEnd.toISOString())
    .order("scheduled_at");
  if (error) {
    console.error("[mcp] getInspectionsByDate failed", error.message);
    return {
      isError: true,
      content: [
        { type: "text", text: "Couldn't load inspections for those dates." },
      ],
    };
  }

  // MCP tool results are a list of content blocks, so the array goes back
  // as JSON text.
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
