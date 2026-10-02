// ai-connection Edge Function.
//
// The app's side of "Integrate your favorite AI". A signed-in user manages
// their ONE AI connection key:
//   { action: "status" }  → { connected, keyPrefix, createdAt, lastUsedAt }
//   { action: "create" }  → { key }      (the only time the key is ever sent)
//   { action: "disable" } → { ok: true } (deletes the key; every AI using it
//                                         loses access immediately)
//
// The caller is always the user from the verified login token — nothing in the
// body says whose key it is. ai_connection_keys is service-role only, so this
// function is the app's only way in. The `mcp` function is what checks keys.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { displayPrefix, generateKey, hashKey } from "../_shared/aiKey.ts";
import { logCloudEvent } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[ai-connection]";
const SOURCE = "ef:ai-connection";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
// Never pass the key or its hash in `fields`.
function logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error: err instanceof Error ? err.message : (anyErr?.message ?? String(err)),
    }),
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient: SupabaseClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);
  const userId = user.id;

  const admin: SupabaseClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = body?.action ?? "";

  try {
    if (action === "status") {
      const { data: row, error } = await admin
        .from("ai_connection_keys")
        .select("key_prefix, created_at, last_used_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        logError("status_failed", error, { userId });
        return json({ error: "db_error" }, 500);
      }
      return json({
        connected: !!row,
        keyPrefix: row?.key_prefix ?? null,
        createdAt: row?.created_at ?? null,
        lastUsedAt: row?.last_used_at ?? null,
      });
    }

    if (action === "create") {
      // One key per user. This check is the first gate; the table's primary key
      // is the second (it catches two creates racing past this check).
      const { data: existing, error: findErr } = await admin
        .from("ai_connection_keys")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (findErr) {
        logError("create_lookup_failed", findErr, { userId });
        return json({ error: "db_error" }, 500);
      }
      if (existing) return json({ error: "already_connected" }, 409);

      const key = generateKey();
      const { error: insertErr } = await admin.from("ai_connection_keys").insert({
        user_id: userId,
        key_hash: await hashKey(key),
        key_prefix: displayPrefix(key),
      });
      if (insertErr) {
        // 23505 = another create for this user won the race.
        if (insertErr.code === "23505") {
          return json({ error: "already_connected" }, 409);
        }
        logError("create_failed", insertErr, { userId });
        return json({ error: "db_error" }, 500);
      }

      await logCloudEvent(admin, SOURCE, "ai.key_created", { userId });
      // The only time the key itself ever leaves the server.
      return json({ key });
    }

    if (action === "disable") {
      // Deleting (not flagging) the row: the key stops working on the very next
      // request. Deleting when there's no key is fine — nothing to disable.
      const { error } = await admin
        .from("ai_connection_keys")
        .delete()
        .eq("user_id", userId);
      if (error) {
        logError("disable_failed", error, { userId });
        return json({ error: "db_error" }, 500);
      }

      await logCloudEvent(admin, SOURCE, "ai.key_deleted", { userId });
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    logError("request_failed", e, { userId, action });
    return json({ error: "server_error" }, 500);
  }
});
