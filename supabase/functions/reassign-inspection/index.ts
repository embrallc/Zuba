// Reassign-inspection Edge Function.
//
// Body: { assignments: [{ inspection_sk: string, new_user_id: string }] }
//
// For each assignment:
//   - Verifies the caller is an owner or admin of the inspection's org
//   - Verifies the new user is in the same org
//   - Calls the `reassign_inspection` RPC to move user_id onto the inspection,
//     its inspection_forms row, and sms_status
//   - Walks the form's answers JSON; for every captured photo, moves the
//     storage object to the new owner's prefix and rewrites its cloudUri, then
//     writes the updated answers back so clients pull the new paths
//
// Response: { results: [{ inspection_sk, ok, error? }] }

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
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

  // Move user_id onto the inspection, its form, and sms_status (with version
  // bumps so clients refresh).
  const { error: rpcErr } = await admin.rpc("reassign_inspection", {
    p_inspection_sk: inspection_sk,
    p_new_user_id: new_user_id,
  });
  if (rpcErr) return { inspection_sk, ok: false, error: rpcErr.message };

  // Relocate the form's photos. They live as refs inside answers JSON now, so
  // load the form, walk it, move each storage object to the new owner's
  // prefix, rewrite the ref's cloudUri, and (if anything moved) save answers
  // back with a fresh _version so the recipient pulls the new paths.
  const { data: form, error: formErr } = await admin
    .from("inspection_forms")
    .select("answers, _version")
    .eq("inspection_sk", inspection_sk)
    .maybeSingle();
  if (formErr) {
    // The user_id reassignment already succeeded; surface the photo problem
    // but don't claim the whole reassign failed.
    console.warn(
      `[reassign-inspection] could not load form sk=${inspection_sk} err=${formErr.message}`,
    );
    return { inspection_sk, ok: true };
  }
  if (form?.answers) {
    const moved = await relocateAnswerPhotos(admin, form.answers, new_user_id);
    if (moved) {
      const { error: saveErr } = await admin
        .from("inspection_forms")
        .update({
          answers: form.answers,
          _version: (form._version ?? 1) + 1,
          _last_changed_at: Date.now(),
        })
        .eq("inspection_sk", inspection_sk);
      if (saveErr) {
        console.warn(
          `[reassign-inspection] saving relocated photo paths failed sk=${inspection_sk} err=${saveErr.message}`,
        );
      }
    }
  }

  return { inspection_sk, ok: true };
}

// A photo field's answer is an array of objects (each a photo ref with id +
// cloudUri); a checkbox answer is an array of strings. The object/string split
// is enough to tell them apart without the schema — same heuristic sync uses.
function isPhotoArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.some((el) => el && typeof el === "object" && "id" in el)
  );
}

// Walk answers.sections[*].instances[*].fields[*], moving every cloud photo to
// the new owner's path prefix and rewriting cloudUri in place. Returns whether
// anything was actually moved (so the caller knows to persist + bump version).
async function relocateAnswerPhotos(
  admin: SupabaseClient,
  answers: { sections?: Record<string, { instances?: { fields?: Record<string, unknown> }[] }> },
  newUserId: string,
): Promise<boolean> {
  let moved = false;
  const sections = answers?.sections;
  if (!sections || typeof sections !== "object") return false;
  for (const sec of Object.values(sections)) {
    for (const inst of sec?.instances ?? []) {
      const fields = inst?.fields;
      if (!fields || typeof fields !== "object") continue;
      for (const value of Object.values(fields)) {
        if (!isPhotoArray(value)) continue;
        for (const ref of value) {
          const oldPath = ref?.cloudUri as string | undefined;
          if (!oldPath) continue;
          const newPath = swapUserIdInPath(oldPath, newUserId);
          if (newPath === oldPath) continue;

          const { error: moveErr } = await admin.storage
            .from(BUCKET)
            .move(oldPath, newPath);
          if (moveErr) {
            console.warn(
              `[reassign-inspection] storage move failed photo=${ref.id} from=${oldPath} to=${newPath} err=${moveErr.message}`,
            );
            continue;
          }
          ref.cloudUri = newPath;
          moved = true;
        }
      }
    }
  }
  return moved;
}

// Path layout is `{orgSk}/{userId}/{detailSk}/{ts}.jpg`. Swap segment 2.
function swapUserIdInPath(oldPath: string, newUserId: string): string {
  const parts = oldPath.split("/");
  if (parts.length < 2) return oldPath;
  parts[1] = newUserId;
  return parts.join("/");
}
