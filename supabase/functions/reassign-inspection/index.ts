// Reassign-inspection Edge Function.
//
// Body: { assignments: [{ inspection_sk: string, new_user_id: string }] }
//
// For each assignment:
//   - Verifies the caller is an owner or admin of the inspection's org
//   - Verifies the new user is in the same org
//   - Calls the `reassign_inspection` RPC to cascade user_id through
//     descriptions, details, and sms_status
//   - For every detail with a cloud photo, moves the storage object to the
//     new owner's prefix and updates cloud_picture_uri
//
// Response: { results: [{ inspection_sk, ok, error? }] }

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const BUCKET = "inspection-images";

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

type Assignment = { inspection_sk: string; new_user_id: string };
type Result = { inspection_sk: string; ok: boolean; error?: string };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Resolve caller's org + role once.
  const { data: me, error: meError } = await admin
    .from("users")
    .select("org_sk, user_profile")
    .eq("id", user.id)
    .single();
  if (meError || !me) return json({ error: "User record not found" }, 404);
  if (!me.org_sk) return json({ error: "Caller has no org" }, 400);
  if (!["owner", "admin"].includes(me.user_profile)) {
    return json({ error: "Only owners and admins can reassign inspections" }, 403);
  }
  const callerOrg: string = me.org_sk;

  let body: { assignments?: Assignment[] } = {};
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const assignments = body.assignments ?? [];
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return json({ error: "assignments array is required" }, 400);
  }

  const results: Result[] = [];
  for (const a of assignments) {
    const out = await reassignOne(admin, callerOrg, a);
    results.push(out);
  }

  return json({ results });
});

async function reassignOne(
  admin: SupabaseClient,
  callerOrg: string,
  a: Assignment,
): Promise<Result> {
  const { inspection_sk, new_user_id } = a;
  if (!inspection_sk || !new_user_id) {
    return { inspection_sk: inspection_sk ?? "", ok: false, error: "missing fields" };
  }

  // Verify inspection belongs to caller's org.
  const { data: insp, error: inspErr } = await admin
    .from("inspections")
    .select("inspection_sk, org_sk")
    .eq("inspection_sk", inspection_sk)
    .maybeSingle();
  if (inspErr) return { inspection_sk, ok: false, error: inspErr.message };
  if (!insp) return { inspection_sk, ok: false, error: "inspection not found" };
  if (insp.org_sk !== callerOrg) {
    return { inspection_sk, ok: false, error: "inspection not in your org" };
  }

  // Verify the new user is in the same org.
  const { data: target, error: tErr } = await admin
    .from("users")
    .select("id, org_sk")
    .eq("id", new_user_id)
    .maybeSingle();
  if (tErr) return { inspection_sk, ok: false, error: tErr.message };
  if (!target || target.org_sk !== callerOrg) {
    return { inspection_sk, ok: false, error: "target user not in your org" };
  }

  // Cascade DB updates and get the list of details that need their storage
  // objects moved.
  const { data: details, error: rpcErr } = await admin.rpc(
    "reassign_inspection",
    { p_inspection_sk: inspection_sk, p_new_user_id: new_user_id },
  );
  if (rpcErr) return { inspection_sk, ok: false, error: rpcErr.message };

  // Move storage objects (best effort — log any individual failure and keep
  // going so a single bad photo doesn't abort the whole reassign).
  for (const d of (details ?? []) as { detail_sk: string; old_cloud_uri: string }[]) {
    const oldPath = d.old_cloud_uri;
    if (!oldPath) continue;
    const newPath = swapUserIdInPath(oldPath, new_user_id);
    if (newPath === oldPath) continue;

    const { error: moveErr } = await admin.storage
      .from(BUCKET)
      .move(oldPath, newPath);
    if (moveErr) {
      console.warn(
        `[reassign-inspection] storage move failed sk=${d.detail_sk} from=${oldPath} to=${newPath} err=${moveErr.message}`,
      );
      continue;
    }
    await admin
      .from("inspection_details")
      .update({ cloud_picture_uri: newPath })
      .eq("inspection_detail_sk", d.detail_sk);
  }

  return { inspection_sk, ok: true };
}

// Path layout is `{orgSk}/{userId}/{detailSk}/{ts}.jpg`. Swap segment 2.
function swapUserIdInPath(oldPath: string, newUserId: string): string {
  const parts = oldPath.split("/");
  if (parts.length < 2) return oldPath;
  parts[1] = newUserId;
  return parts.join("/");
}
