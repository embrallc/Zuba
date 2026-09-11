// drive-manage Edge Function.
//
// Owner-only mutations for the Google Drive connection — the one write endpoint
// behind the settings screen. Three actions:
//
//   disconnect   — revoke the grant at Google, delete the Vault secret, drop the
//                  connection row. Files already in their Drive stay theirs.
//   retry_failed — re-arm failed syncs for this org and nudge the runner now
//                  (instead of waiting up to 5 minutes for the cron sweep).
//   set_enabled  — the master "back up completed inspections" switch.
//
// Kept separate from drive-status on purpose: reads and writes shouldn't share
// an endpoint. Authorization is read from the DB (owner of the org), never from
// the request body.
//
// Body: { action: "disconnect" | "retry_failed" | "set_enabled", enabled?: bool }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { revokeRefreshToken } from "../_shared/googleDrive.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[drive-manage]";
// Cap the immediate re-drive; anything beyond this is picked up by the sweep.
const RETRY_NUDGE_LIMIT = 10;

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

  const admin: SupabaseClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: me, error: meErr } = await admin
    .from("users")
    .select("user_profile, org_sk")
    .eq("id", user.id)
    .single();
  if (meErr || !me?.org_sk) return json({ error: "no_org" }, 400);
  if (me.user_profile !== "owner") return json({ error: "owner_only" }, 403);
  const orgSk = me.org_sk as string;

  let body: { action?: string; enabled?: boolean } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const action = body?.action ?? "";

  try {
    // ── Disconnect ───────────────────────────────────────────────────────────
    if (action === "disconnect") {
      // Revoke at Google FIRST so the grant is gone even if a later step fails —
      // the worst outcome is a dead token we then delete anyway.
      let revoked = false;
      const { data: token, error: tokenErr } = await admin.rpc("drive_secret_get", {
        p_org_sk: orgSk,
      });
      if (tokenErr) logError("vault_get_failed", tokenErr, { orgSk });
      if (typeof token === "string" && token) {
        revoked = await revokeRefreshToken(token);
      }

      const { error: delSecretErr } = await admin.rpc("drive_secret_del", {
        p_org_sk: orgSk,
      });
      if (delSecretErr) {
        logError("vault_del_failed", delSecretErr, { orgSk });
        return json({ error: "disconnect_failed" }, 500);
      }

      const { error: delErr } = await admin
        .from("drive_connections")
        .delete()
        .eq("org_sk", orgSk);
      if (delErr) {
        logError("connection_delete_failed", delErr, { orgSk });
        return json({ error: "disconnect_failed" }, 500);
      }

      // drive_folders / drive_backups are deliberately KEPT: reconnecting the
      // same account reuses the same folders instead of duplicating them, and a
      // reconnect with a DIFFERENT account self-heals (the runner recreates
      // anything Drive now reports as 404).
      logInfo("disconnected", { orgSk, revokedAtGoogle: revoked });
      return json({ ok: true, revoked });
    }

    // ── Master switch ────────────────────────────────────────────────────────
    if (action === "set_enabled") {
      const enabled = body?.enabled === true;
      const { error } = await admin
        .from("drive_connections")
        .update({ backup_enabled: enabled, updated_at: new Date().toISOString() })
        .eq("org_sk", orgSk);
      if (error) {
        logError("set_enabled_failed", error, { orgSk, enabled });
        return json({ error: "db_error" }, 500);
      }
      logInfo("backup_enabled_changed", { orgSk, enabled });
      return json({ ok: true, backupEnabled: enabled });
    }

    // ── Retry failures now ───────────────────────────────────────────────────
    if (action === "retry_failed") {
      const { data: rearmed, error } = await admin
        .from("drive_syncs")
        .update({
          status: "pending",
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("org_sk", orgSk)
        .eq("status", "failed")
        .select("inspection_sk");
      if (error) {
        logError("retry_rearm_failed", error, { orgSk });
        return json({ error: "db_error" }, 500);
      }

      // Also clear per-file failures so the diff genuinely re-attempts them.
      await admin
        .from("drive_backups")
        .update({ status: "pending", attempts: 0, last_error: null })
        .eq("org_sk", orgSk)
        .eq("status", "failed");

      const list = (rearmed ?? []).slice(0, RETRY_NUDGE_LIMIT);
      for (const row of list) {
        // Fire-and-forget: the cron sweep is the backstop if any of these drop.
        void fetch(`${url}/functions/v1/drive-backup`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${service}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inspectionSk: row.inspection_sk }),
        }).catch((e) => logError("retry_nudge_failed", e, { orgSk }));
      }

      logInfo("retry_requested", { orgSk, count: rearmed?.length ?? 0 });
      return json({ ok: true, retried: rearmed?.length ?? 0 });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    logError("manage_failed", e, { orgSk, action });
    return json({ error: "server_error" }, 500);
  }
});
