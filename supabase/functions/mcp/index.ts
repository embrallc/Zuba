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
// in the request body does — and it only opens the tools registered in
// zanbiMcp.ts.

import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.31.0/server/webStandardStreamableHttp.js";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hashKey, KEY_PREFIX } from "../_shared/aiKey.ts";
import { RateLimiter } from "../_shared/rateLimiter.ts";
import { ZanbiMcp } from "./zanbiMcp.ts";

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

  // Find the key's user, stamping last_used_at for Settings, in one statement.
  const { data: conn, error: keyErr } = await supabase
    .from("ai_connection_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", await hashKey(key))
    .select("user_id")
    .maybeSingle();
  if (keyErr) {
    console.error("[mcp] key lookup failed", keyErr.message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!conn) {
    console.warn("[mcp] rejected: invalid key");
    return unauthorized();
  }
  const userId: string = conn.user_id;

  // Per-user call limits, so an AI agent stuck in a loop (or a leaked key)
  // can't hammer the database. The numbers live in public.rate_limits
  // (scope "mcp"); change them there, no deploy needed.
  const limiter = new RateLimiter(supabase, "mcp");
  const verdict = await limiter.check(userId);
  if (!verdict.allowed) return limiter.reject(verdict);

  let msg;
  try {
    msg = await req.json();
  } catch {
    return replyError(null, -32700, "Parse error");
  }

  // A new server with every tool registered, built for this request's user.
  // If it couldn't be built, send its error straight back.
  const server = await ZanbiMcp.buildServer(supabase, userId);
  if ("error" in server) {
    return Response.json(server, { status: server.code });
  }

  // Hand the message to the SDK. It answers initialize, tools/list and
  // tools/call from the tools registered on the server.
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
