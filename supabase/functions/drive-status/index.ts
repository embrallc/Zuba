// drive-status Edge Function.
//
// Owner-only read of the org's Google Drive connection + recent backup activity.
// The drive_* tables are service-role only (the app has no direct read path), so
// this is the ONLY way the settings screen learns anything — which keeps the org
// scoping in one server-side place.
//
// Returns: { connected, status, googleEmail, backupEnabled, connectedAt,
//            lastBackupAt, lastError, counts:{done,pending,failed}, recent:[…] }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[drive-status]";
const RECENT_LIMIT = 20;

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

  try {
    const { data: conn, error: connErr } = await admin
      .from("drive_connections")
      .select(
        "status, backup_enabled, google_email, connected_at, last_backup_at, last_error",
      )
      .eq("org_sk", orgSk)
      .maybeSingle();
    if (connErr) {
      logError("connection_lookup_failed", connErr, { orgSk });
      return json({ error: "db_error" }, 500);
    }

    // Never connected → a clean "not connected" shape rather than an error, so
    // the screen has one code path.
    if (!conn || conn.status === "pending") {
      return json({
        connected: false,
        status: conn?.status ?? "none",
        googleEmail: null,
        backupEnabled: false,
        connectedAt: null,
        lastBackupAt: null,
        lastError: conn?.last_error ?? null,
        counts: { done: 0, pending: 0, failed: 0 },
        recent: [],
      });
    }

    const { data: syncs, error: syncErr } = await admin
      .from("drive_syncs")
      .select(
        "inspection_sk, status, files_done, files_total, synced_at, last_error, updated_at",
      )
      .eq("org_sk", orgSk)
      .order("updated_at", { ascending: false })
      .limit(RECENT_LIMIT);
    if (syncErr) {
      logError("sync_lookup_failed", syncErr, { orgSk });
      return json({ error: "db_error" }, 500);
    }

    // Label the rows with the property so the list is readable. Separate query
    // (not a PostgREST embed) to keep this resilient to relationship naming.
    const ids = (syncs ?? []).map((s) => s.inspection_sk);
    const labels = new Map<string, string>();
    if (ids.length) {
      const { data: insps } = await admin
        .from("inspections")
        .select("inspection_sk, full_name, address_line1, city")
        .in("inspection_sk", ids);
      for (const i of insps ?? []) {
        const addr = [i.address_line1, i.city].filter(Boolean).join(", ");
        labels.set(i.inspection_sk, addr || i.full_name || "Inspection");
      }
    }

    // Whole-org totals (the recent list is only a window).
    const countFor = async (status: string) => {
      const { count } = await admin
        .from("drive_syncs")
        .select("inspection_sk", { count: "exact", head: true })
        .eq("org_sk", orgSk)
        .eq("status", status);
      return count ?? 0;
    };
    const [done, failed] = await Promise.all([
      countFor("done"),
      countFor("failed"),
    ]);
    const { count: inFlight } = await admin
      .from("drive_syncs")
      .select("inspection_sk", { count: "exact", head: true })
      .eq("org_sk", orgSk)
      .in("status", ["pending", "running"]);

    return json({
      connected: conn.status === "connected",
      status: conn.status,
      googleEmail: conn.google_email ?? null,
      backupEnabled: !!conn.backup_enabled,
      connectedAt: conn.connected_at ?? null,
      lastBackupAt: conn.last_backup_at ?? null,
      lastError: conn.last_error ?? null,
      counts: { done, pending: inFlight ?? 0, failed },
      recent: (syncs ?? []).map((s) => ({
        inspectionSk: s.inspection_sk,
        label: labels.get(s.inspection_sk) ?? "Inspection",
        status: s.status,
        filesDone: s.files_done ?? 0,
        filesTotal: s.files_total ?? 0,
        syncedAt: s.synced_at ?? null,
        updatedAt: s.updated_at ?? null,
        lastError: s.last_error ?? null,
      })),
    });
  } catch (e) {
    logError("status_failed", e, { orgSk });
    return json({ error: "server_error" }, 500);
  }
});
