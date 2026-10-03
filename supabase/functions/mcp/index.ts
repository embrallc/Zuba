// mcp — MCP server endpoint for any AI agent or skill (Muse, ChatGPT, Claude,
// a script on the user's computer…).
//
// Every MCP message is JSON-RPC 2.0:
//   request:  { jsonrpc: "2.0", id, method, params }
//   response: { jsonrpc: "2.0", id, result }  or  { jsonrpc: "2.0", id, error }
//
// Callers authenticate with the user's AI connection key, created in the app
// (Settings → Integrate your favorite AI) and sent as
// `Authorization: Bearer zanbi_ai_…`. The key decides WHO is calling — nothing
// in the request body does — and it only opens the tools registered below.

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.31.0/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.31.0/server/webStandardStreamableHttp.js";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@4.6.5";
import dayjs from "npm:dayjs@1.11.23";
import customParseFormat from "npm:dayjs@1.11.23/plugin/customParseFormat.js";
import utc from "npm:dayjs@1.11.23/plugin/utc.js";
import timezone from "npm:dayjs@1.11.23/plugin/timezone.js";
import { hashKey, KEY_PREFIX } from "../_shared/aiKey.ts";
import { logCloudEvent } from "../_shared/logToCloud.ts";

// Day.js plugins: strict format parsing, and timezone-aware dates (timezone
// needs utc). Same for every request, so they're set up once here.
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

function replyError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

// Missing, malformed or unknown key all get the same answer, so a caller can't
// tell which part was wrong.
function unauthorized() {
  return Response.json(
    { error: "invalid_key", message: "Missing or invalid Zanbi AI connection key." },
    { status: 401 },
  );
}

// Per-key limits, so an AI agent stuck in a loop (or a leaked key) can't hammer
// the database. Tune them here. For scale: an AI app connecting makes about 3
// calls (initialize, initialized, tools/list) before its first tool call.
const MAX_CALLS_PER_MINUTE = 30;
const MAX_CALLS_PER_DAY = 1000;

type KeyHit = { user_id: string; minute_calls: number; day_calls: number };

// Over a limit: answer 429 and say how long to wait. Only the FIRST call over
// a limit is logged, so a runaway agent doesn't flood the logs as well.
async function rateLimited(supabase: SupabaseClient, hit: KeyHit) {
  const overDay = hit.day_calls > MAX_CALLS_PER_DAY;
  const now = new Date();
  // The counts reset at the next minute / next UTC midnight.
  const retryAfterSeconds = overDay
    ? Math.ceil(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) -
        now.getTime()) / 1000,
    )
    : 60 - now.getUTCSeconds();

  const firstCallOver = overDay
    ? hit.day_calls === MAX_CALLS_PER_DAY + 1
    : hit.minute_calls === MAX_CALLS_PER_MINUTE + 1;
  if (firstCallOver) {
    const limit = overDay ? "day" : "minute";
    console.warn("[mcp] rate limited", JSON.stringify({ userId: hit.user_id, limit }));
    await logCloudEvent(supabase, "ef:mcp", "ai.rate_limited", {
      userId: hit.user_id,
      data: { limit, minuteCalls: hit.minute_calls, dayCalls: hit.day_calls },
    });
  }

  return Response.json(
    {
      error: "rate_limited",
      message: overDay
        ? "This AI connection has reached its daily limit. Try again tomorrow."
        : "Too many requests from this AI connection. Wait a minute, then try again.",
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Service-role client: there's no logged-in user on this call, so RLS can't
  // scope anything. The key check below decides the user, and every query
  // MUST filter to that user.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Who is calling? Only the key can say, so check it before doing anything
  // else. Never log the key itself.
  const auth = req.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!key.startsWith(KEY_PREFIX)) {
    console.warn("[mcp] rejected: invalid key");
    return unauthorized();
  }

  // Find the key's user AND count this call, in one database step (see the
  // ai_key_hit function in the migrations). It also stamps last_used_at.
  const { data: hit, error: keyErr } = await supabase
    .rpc("ai_key_hit", { p_key_hash: await hashKey(key) })
    .maybeSingle<KeyHit>();
  if (keyErr) {
    console.error("[mcp] key lookup failed", keyErr.message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!hit) {
    console.warn("[mcp] rejected: invalid key");
    return unauthorized();
  }
  if (hit.minute_calls > MAX_CALLS_PER_MINUTE || hit.day_calls > MAX_CALLS_PER_DAY) {
    return rateLimited(supabase, hit);
  }
  const userId: string = hit.user_id;

  let msg;
  try {
    msg = await req.json();
  } catch {
    return replyError(null, -32700, "Parse error");
  }

  // A new server on every request — this runs inside the handler, so nothing
  // carries over between calls.
  const server = new McpServer({
    name: "zanbi",
    version: "1.0.0",
  });

  server.registerTool(
    "getTodaysInspections",
    {
      description:
        "List the inspections the user has scheduled on a given date.",
      inputSchema: {
        // The AI turns "today" / "tomorrow" into a real date; the description
        // tells it which format to send. zod only checks it's a string — the
        // format is checked with Day.js inside the tool.
        date: z
          .string()
          .describe(
            "The day to look up, as YYYY-MM-DD in the user's local time.",
          ),
      },
    },
    // The SDK's zod typing doesn't come through under Deno, so the type is
    // spelled out here for the editor. zod still validates the real input.
    async ({ date }: { date: string }) => {
      // Strict parse (the `true`): the string must be exactly YYYY-MM-DD and a
      // real day, so "2026-02-30" and "tomorrow" both fail.
      if (!dayjs(date, "YYYY-MM-DD", true).isValid()) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Wrong date format, must be YYYY-MM-DD." },
          ],
        };
      }

      const { data: user, error: userErr } = await supabase
        .from("users")
        .select("org_sk")
        .eq("id", userId)
        .maybeSingle();
      if (userErr) {
        console.error("[mcp] user lookup failed", userErr.message);
        return {
          isError: true,
          content: [{ type: "text", text: "Couldn't look up that user." }],
        };
      }
      if (!user) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown user." }],
        };
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("timezone")
        .eq("org_sk", user.org_sk)
        .maybeSingle();
      const timeZone = org?.timezone ?? "America/Chicago";

      // scheduled_at is a timestamp, so it can't equal a date directly — match
      // everything from local midnight to the next local midnight. "Local"
      // means the org's timezone, not UTC (8pm in Chicago is already tomorrow
      // in UTC). Day.js handles the 23h/25h daylight-saving days.
      const dayStart = dayjs.tz(date, timeZone);
      const dayEnd = dayStart.add(1, "day");
      const { data, error } = await supabase
        .from("inspections")
        .select("full_name, address_line1, city, zip_code, scheduled_at")
        .eq("user_id", userId)
        .not("_deleted", "is", true)
        .gte("scheduled_at", dayStart.toISOString())
        .lt("scheduled_at", dayEnd.toISOString())
        .order("scheduled_at");
      if (error) {
        console.error("[mcp] getTodaysInspections failed", error.message);
        return {
          isError: true,
          content: [
            { type: "text", text: "Couldn't load inspections for that date." },
          ],
        };
      }

      // MCP tool results are a list of content blocks, so the array goes back
      // as JSON text.
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  // Hand the message to the SDK. It answers initialize, tools/list and
  // tools/call from the tools registered above.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: nothing is kept between calls
    enableJsonResponse: true, // plain JSON replies instead of an event stream
  });
  await server.connect(transport);

  // Plain HTTP callers (like a Muse skill) often skip the Accept and
  // Content-Type headers the transport insists on (it answers 406/415 without
  // them). The body is already parsed JSON, so set both before handing over.
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  return transport.handleRequest(
    new Request(req.url, { method: "POST", headers }),
    { parsedBody: msg }, // the body was already read above
  );
});
