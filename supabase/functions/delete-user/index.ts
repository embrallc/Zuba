// Delete-user Edge Function.
//
// Lets an organization owner delete another user's account (for cases like
// "user left without removing themselves"). The target's records are NOT
// wiped — they're orphaned (user_id = NULL) so the surviving owner can
// reassign them from the Unassigned Records screen.
//
// Body: { target_user_id: string }
//
// Response:
//   200 { status: "user_deleted", target_user_id }
//   4xx { error }
//
// Security:
//   - Caller must be an authenticated user.
//   - Caller's DB row must have user_profile = 'owner'.
//   - Target must belong to the same org as the caller.
//   - Target must NOT be the caller — self-delete goes through `delete-account`
//     because that flow has the full-org-wipe and sole-owner-block branches
//     which don't apply when one owner removes another user.
//
// Telemetry: every step writes a `[delete-user]` log line.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[delete-user]";

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

function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(`${TAG} ${event}`, JSON.stringify(fields));
}

function logError(
  event: string,
  err: unknown,
  fields: Record<string, unknown> = {},
) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  const payload: Record<string, unknown> = {
    ...fields,
    error:
      err instanceof Error
        ? err.message
        : (anyErr?.message as string | undefined) ?? String(err),
    code: anyErr?.code,
    details: anyErr?.details,
    hint: anyErr?.hint,
    status: anyErr?.status,
    stack: err instanceof Error ? err.stack : undefined,
  };
  console.error(`${TAG} ${event}`, JSON.stringify(payload));
}

serve(async (req) => {
  const t0 = Date.now();
  logInfo("request", { method: req.method });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    logInfo("rejected.no_auth_header");
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { target_user_id?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const targetUserId = body.target_user_id;
  if (!targetUserId || typeof targetUserId !== "string") {
    return json({ error: "target_user_id is required" }, 400);
  }

  let userClient: SupabaseClient;
  let admin: SupabaseClient;
  try {
    userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  } catch (e) {
    logError("client_create_failed", e);
    return json({ error: "Server misconfigured" }, 500);
  }

  // Identify caller.
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) {
    logError("jwt_verify_failed", userError ?? new Error("no user"));
    return json({ error: "Unauthorized" }, 401);
  }
  logInfo("jwt_verified", { caller_id: user.id });

  if (user.id === targetUserId) {
    logInfo("rejected.self_target", { caller_id: user.id });
    return json(
      {
        error:
          "Use the Delete Account flow to delete your own account.",
      },
      400,
    );
  }

  // Caller must be owner.
  const { data: me, error: meErr } = await admin
    .from("users")
    .select("id, user_profile, org_sk")
    .eq("id", user.id)
    .single();
  if (meErr || !me) {
    logError("caller_lookup_failed", meErr ?? new Error("no row"), {
      caller_id: user.id,
    });
    return json({ error: "Caller not found" }, 404);
  }
  if (me.user_profile !== "owner") {
    logInfo("rejected.not_owner", {
      caller_id: user.id,
      caller_profile: me.user_profile,
    });
    return json({ error: "Only owners can delete users" }, 403);
  }
  if (!me.org_sk) {
    logInfo("rejected.caller_no_org", { caller_id: user.id });
    return json({ error: "Caller has no org" }, 400);
  }

  // Target must be in the same org.
  const { data: target, error: tErr } = await admin
    .from("users")
    .select("id, org_sk, user_profile, fname, lname")
    .eq("id", targetUserId)
    .maybeSingle();
  if (tErr) {
    logError("target_lookup_failed", tErr, { target_user_id: targetUserId });
    return json({ error: tErr.message }, 500);
  }
  if (!target) {
    logInfo("rejected.target_not_found", { target_user_id: targetUserId });
    return json({ error: "Target user not found" }, 404);
  }
  if (target.org_sk !== me.org_sk) {
    logInfo("rejected.cross_org", {
      caller_org: me.org_sk,
      target_org: target.org_sk,
    });
    return json({ error: "Target user is not in your org" }, 403);
  }
  logInfo("target_loaded", {
    target_user_id: targetUserId,
    target_profile: target.user_profile,
  });

  // Orphan + auth delete. The caller remains an owner so the org never ends
  // up with zero owners (the invariant is automatic in this flow).
  const { error: rpcError } = await admin.rpc("delete_user_orphan", {
    p_user_id: targetUserId,
  });
  if (rpcError) {
    logError("delete_user_orphan_failed", rpcError, {
      target_user_id: targetUserId,
    });
    return json({ error: rpcError.message }, 500);
  }

  logInfo("done.user_deleted", {
    caller_id: user.id,
    target_user_id: targetUserId,
    elapsed_ms: Date.now() - t0,
  });
  return json({ status: "user_deleted", target_user_id: targetUserId });
});
