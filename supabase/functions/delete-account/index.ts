// Delete-account Edge Function.
//
// All destructive logic runs here so the service-role key never touches the
// client. The caller's JWT is verified first; their user_profile + org_sk
// are read from the DB (not from JWT claims that could be tampered with).
//
// Response shape (always HTTP 200 unless something genuinely failed):
//   { status: "full_org_deleted" }
//   { status: "user_only_deleted" }
//   { status: "blocked_sole_owner", message }
//
// HTTP 4xx/5xx are only used for auth/server errors. The "blocked" case is
// a normal decision, not a server fault — clients branch on `status`.
//
// Telemetry: every step writes a structured `[delete-account]` log line so
// the trail is visible in the Supabase Edge Function logs.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

// Deno globals provided by the Supabase Edge Function runtime — declared
// here so the local TypeScript IDE doesn't complain about missing types.
declare const Deno: { env: { get(name: string): string | undefined } };

const BUCKET = "inspection-images";
const TAG = "[delete-account]";

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
  // Supabase errors come back as plain `PostgrestError`-shaped objects (with
  // message / code / details / hint), not Error instances — surface every
  // field we know about so the cause isn't hidden behind "[object Object]".
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
    name: anyErr?.name,
    stack: err instanceof Error ? err.stack : undefined,
  };
  console.error(`${TAG} ${event}`, JSON.stringify(payload));
}

serve(async (req) => {
  const t0 = Date.now();
  logInfo("request", { method: req.method, url: req.url });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    logInfo("rejected.method_not_allowed", { method: req.method });
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    logInfo("rejected.no_auth_header");
    return json({ error: "Unauthorized" }, 401);
  }

  let userClient: SupabaseClient;
  try {
    userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
  } catch (e) {
    logError("user_client_create_failed", e);
    return json({ error: "Server misconfigured" }, 500);
  }

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) {
    logError("jwt_verify_failed", userError ?? new Error("no user"));
    return json({ error: "Unauthorized" }, 401);
  }
  logInfo("jwt_verified", { user_id: user.id });

  let admin: SupabaseClient;
  try {
    admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  } catch (e) {
    logError("admin_client_create_failed", e);
    return json({ error: "Server misconfigured" }, 500);
  }

  // Read profile + org from DB (source of truth).
  const { data: me, error: meError } = await admin
    .from("users")
    .select("id, user_profile, org_sk")
    .eq("id", user.id)
    .single();
  if (meError || !me) {
    logError("user_record_lookup_failed", meError ?? new Error("no row"), {
      user_id: user.id,
    });
    return json({ error: "User record not found" }, 404);
  }
  const orgSk: string | null = me.org_sk;
  const profile: string | null = me.user_profile;
  logInfo("user_loaded", { user_id: user.id, profile, org_sk: orgSk });

  if (!orgSk) {
    logInfo("rejected.missing_org_sk", { user_id: user.id });
    return json({ error: "User has no org_sk" }, 500);
  }

  // Count total users + owners in the org.
  const { count: totalUsers, error: totalUsersError } = await admin
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("org_sk", orgSk);
  if (totalUsersError) {
    logError("count_total_users_failed", totalUsersError, { org_sk: orgSk });
    return json({ error: totalUsersError.message }, 500);
  }

  const { count: totalOwners, error: totalOwnersError } = await admin
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("org_sk", orgSk)
    .eq("user_profile", "owner");
  if (totalOwnersError) {
    logError("count_total_owners_failed", totalOwnersError, { org_sk: orgSk });
    return json({ error: totalOwnersError.message }, 500);
  }
  logInfo("counts", {
    org_sk: orgSk,
    total_users: totalUsers,
    total_owners: totalOwners,
  });

  if (profile === "owner") {
    if ((totalUsers ?? 0) <= 1) {
      logInfo("path.full_org_delete", { org_sk: orgSk });
      const swept = await sweepStoragePrefix(admin, orgSk);
      if (!swept.ok) {
        logError("storage_sweep_failed", new Error(swept.error ?? "unknown"), {
          org_sk: orgSk,
        });
        return json({ error: swept.error }, 500);
      }
      logInfo("storage_sweep_done", {
        org_sk: orgSk,
        files_removed: swept.removed,
      });

      const { error: rpcError } = await admin.rpc("delete_org_cascade", {
        p_org_sk: orgSk,
      });
      if (rpcError) {
        logError("delete_org_cascade_failed", rpcError, { org_sk: orgSk });
        return json({ error: rpcError.message }, 500);
      }
      logInfo("done.full_org_deleted", {
        org_sk: orgSk,
        elapsed_ms: Date.now() - t0,
      });
      return json({ status: "full_org_deleted" });
    }

    if ((totalOwners ?? 0) <= 1) {
      logInfo("path.blocked_sole_owner", { org_sk: orgSk });
      return json({
        status: "blocked_sole_owner",
        message:
          "You're the only owner of this organization. Promote another user to owner in Manage Users before deleting your account.",
      });
    }

    logInfo("path.user_only_delete.owner", { org_sk: orgSk, user_id: user.id });
    return await userOnlyDelete(admin, user.id, t0);
  }

  // admin / member
  logInfo("path.user_only_delete.non_owner", {
    org_sk: orgSk,
    user_id: user.id,
    profile,
  });
  return await userOnlyDelete(admin, user.id, t0);
});

async function userOnlyDelete(
  admin: SupabaseClient,
  userId: string,
  t0: number,
) {
  // Records the user created are left orphaned (user_id = NULL); the
  // Unassigned Records screen surfaces them for an owner/admin to reassign.
  const { error: rpcError } = await admin.rpc("delete_user_orphan", {
    p_user_id: userId,
  });
  if (rpcError) {
    logError("delete_user_orphan_failed", rpcError, { user_id: userId });
    return json({ error: rpcError.message }, 500);
  }
  logInfo("done.user_only_deleted", {
    user_id: userId,
    elapsed_ms: Date.now() - t0,
  });
  return json({ status: "user_only_deleted" });
}

type SweepResult = { ok: boolean; removed: number; error: string | null };

// Recursively list and delete every object under the given prefix in the
// inspection-images bucket. Storage API has no native "delete tree" — we
// BFS the virtual folder structure.
async function sweepStoragePrefix(
  admin: SupabaseClient,
  prefix: string,
): Promise<SweepResult> {
  const queue: string[] = [prefix];
  let removed = 0;
  try {
    while (queue.length > 0) {
      const current = queue.shift()!;
      const { data: items, error } = await admin.storage
        .from(BUCKET)
        .list(current, { limit: 1000 });
      if (error) {
        logError("storage_list_failed", error, { prefix: current });
        throw error;
      }
      if (!items || items.length === 0) {
        logInfo("storage_list.empty", { prefix: current });
        continue;
      }
      logInfo("storage_list", { prefix: current, items: items.length });

      const files: string[] = [];
      for (const item of items) {
        const full = `${current}/${item.name}`;
        // Files have an `id`; virtual folders do not.
        if (item.id != null) files.push(full);
        else queue.push(full);
      }
      if (files.length > 0) {
        const { error: rmErr } = await admin.storage.from(BUCKET).remove(files);
        if (rmErr) {
          logError("storage_remove_failed", rmErr, {
            prefix: current,
            file_count: files.length,
          });
          throw rmErr;
        }
        removed += files.length;
        logInfo("storage_removed", { prefix: current, count: files.length });
      }
    }
    return { ok: true, removed, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, removed, error: msg };
  }
}
