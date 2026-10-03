// ZanbiMcp — builds the MCP server and registers every Zanbi tool on it.
//
// index.ts calls ZanbiMcp.buildServer(supabase, userId) once per request and
// gets back a NEW server, or a BuildError to send straight back. The tools
// hold this request's caller, so a server must never be kept and reused, and
// per-user data never goes in a static field: a warm instance shares statics
// between requests, so the next caller would get the previous caller's data.

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.31.0/server/mcp.js";
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@4.6.5";
import { type Caller, getInspectionsByDate, MAX_RANGE_DAYS } from "./tools.ts";

// What buildServer returns instead of a server when it can't build one.
// `code` is the HTTP status index.ts answers with.
export type BuildError = { error: true; code: number; message: string };

// The caller lookup's row: the user with their org embedded. PostgREST sends
// the org as one object (a user has one org), not the array supabase-js
// guesses when it doesn't know the tables.
type CallerRow = {
  org_sk: string | null;
  organizations: { timezone: string | null } | null;
};

export class ZanbiMcp {
  static async buildServer(
    supabase: SupabaseClient,
    userId: string,
  ): Promise<McpServer | BuildError> {
    // Work out who is calling once, before any tool runs, so no tool has to
    // repeat it.
    const caller = await ZanbiMcp.loadCaller(supabase, userId);
    if ("error" in caller) return caller;

    const server = new McpServer({
      name: "zanbi",
      version: "1.0.0",
    });

    server.registerTool(
      "getInspectionsByDate",
      {
        description:
          `List the inspections the user has scheduled from startDate through endDate (both days included), up to ${MAX_RANGE_DAYS} days per call. For a single day, send the same date for both.`,
        inputSchema: {
          // The AI turns "today" / "next week" into real dates; the
          // descriptions tell it which format to send. zod only checks
          // they're strings — the format and range are checked inside the tool.
          startDate: z
            .string()
            .describe(
              "First day to include, as YYYY-MM-DD in the user's local time.",
            ),
          endDate: z
            .string()
            .describe(
              "Last day to include, as YYYY-MM-DD in the user's local time. Same as startDate for one day.",
            ),
        },
      },
      // The SDK's zod typing doesn't come through under Deno, so the types
      // are spelled out here for the editor. zod still validates the real input.
      ({ startDate, endDate }: { startDate: string; endDate: string }) =>
        getInspectionsByDate(supabase, caller, startDate, endDate),
    );

    return server;
  }

  // Who is calling: the user's org and that org's timezone, in one query, or
  // a BuildError if that can't be loaded. The `!users_org_sk_fk` names which
  // link to follow: users and organizations are joined twice (the user's org,
  // and the org's billing owner).
  private static async loadCaller(
    supabase: SupabaseClient,
    userId: string,
  ): Promise<Caller | BuildError> {
    const { data: user, error } = await supabase
      .from("users")
      .select("org_sk, organizations!users_org_sk_fk(timezone)")
      .eq("id", userId)
      .maybeSingle<CallerRow>();
    if (error || !user) {
      console.error("[mcp] caller lookup failed", error?.message ?? "no users row");
      return { error: true, code: 500, message: "Couldn't load your Zanbi account." };
    }
    return {
      userId,
      orgSk: user.org_sk,
      timeZone: user.organizations?.timezone ?? "America/Chicago",
    };
  }
}
