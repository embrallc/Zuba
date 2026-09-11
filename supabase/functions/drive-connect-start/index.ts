// drive-connect-start Edge Function.
//
// Owner-only. Step 1 of connecting the org's Google Drive: mint a CSRF `state`
// and a PKCE verifier, park them on a pending drive_connections row, and return
// Google's hosted consent URL for the app to open in a system browser sheet.
//
// Everything secret stays here: the app never sees the client_secret, the PKCE
// verifier, or (later) the refresh token. It only opens the URL we return, and
// Google bounces the browser to drive-oauth-callback with an auth code.
//
// Body: { returnUrl?: <app deep link> }.  Returns: { url }.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildAuthUrl,
  driveRedirectUri,
  googleOAuthConfig,
  pkceChallenge,
  randomToken,
} from "../_shared/googleDrive.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[drive-connect-start]";
const DEFAULT_RETURN = "clientmanagment://drive-return";
// Same allow-list as stripe-return: we will only ever bounce the browser back to
// one of OUR app schemes, never an arbitrary URL an attacker supplied.
const ALLOWED_SCHEMES = ["clientmanagment://", "exp://", "exps://"];
// The consent screen is a human interaction; 10 minutes is generous and keeps a
// stale `state` from lingering as a usable handle on the org.
const STATE_TTL_MS = 10 * 60 * 1000;

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
      code: anyErr?.code,
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

  // Authorization is decided HERE, from the database — never from the request.
  const { data: me, error: meErr } = await admin
    .from("users")
    .select("user_profile, org_sk")
    .eq("id", user.id)
    .single();
  if (meErr || !me?.org_sk) {
    logError("user_lookup_failed", meErr ?? new Error("no org"), { user_id: user.id });
    return json({ error: "no_org" }, 400);
  }
  if (me.user_profile !== "owner") return json({ error: "owner_only" }, 403);
  const orgSk = me.org_sk as string;

  let body: { returnUrl?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const requested = typeof body?.returnUrl === "string" ? body.returnUrl : "";
  const returnTo = ALLOWED_SCHEMES.some((p) => requested.startsWith(p))
    ? requested
    : DEFAULT_RETURN;

  try {
    // Fails fast with a clear message if the project's Google secrets are unset.
    const { clientId } = googleOAuthConfig();
    const redirectUri = driveRedirectUri();

    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = await pkceChallenge(verifier);

    // One connection row per org. Re-connecting overwrites the handshake fields;
    // an existing CONNECTED row keeps its status until the callback succeeds, so
    // an abandoned re-consent can never knock a working connection offline.
    const { error: upErr } = await admin
      .from("drive_connections")
      .upsert(
        {
          org_sk: orgSk,
          oauth_state: state,
          oauth_verifier: verifier,
          oauth_return_to: returnTo,
          oauth_expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
          connected_by: user.id,
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_sk" },
      );
    if (upErr) {
      logError("persist_state_failed", upErr, { orgSk });
      return json({ error: "db_error" }, 500);
    }

    const authUrl = buildAuthUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    });
    logInfo("consent_url_created", { orgSk });
    return json({ url: authUrl });
  } catch (e) {
    logError("start_failed", e, { orgSk });
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "google_not_configured", detail }, 502);
  }
});
