// drive-oauth-callback Edge Function.
//
// Step 2 of connecting Google Drive: Google redirects the browser here with an
// auth code. We exchange it (with the client_secret + PKCE verifier, both
// server-side only) for a REFRESH token, store that in Supabase Vault, and then
// 302 the browser back into the app's deep link.
//
// Deployed with verify_jwt = false: Google holds no Supabase JWT. The `state`
// parameter is the authorization — it's a 32-byte random value we minted in
// drive-connect-start, stored against exactly one org, single-use, and expiring
// in 10 minutes. No token or code is ever put in the redirect we hand back.
//
// ⚠️ The Supabase shared functions domain force-downgrades text/html to
// text/plain (anti-phishing), so an HTML/JS redirect page would render as raw
// text and never run. It MUST be a real HTTP 302 — same as stripe-return.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  driveRedirectUri,
  exchangeCode,
  fetchAccountInfo,
} from "../_shared/googleDrive.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[drive-oauth-callback]";
const ALLOWED_SCHEMES = ["clientmanagment://", "exp://", "exps://"];
const FALLBACK_RETURN = "clientmanagment://drive-return";

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

// Bounce back into the app. `reason` is a short machine code for the settings
// screen — never a token, and never anything sensitive.
function redirectToApp(returnTo: string | null, status: string, reason?: string) {
  const base = returnTo && ALLOWED_SCHEMES.some((p) => returnTo.startsWith(p))
    ? returnTo
    : FALLBACK_RETURN;
  const sep = base.includes("?") ? "&" : "?";
  const qs = `status=${encodeURIComponent(status)}` +
    (reason ? `&reason=${encodeURIComponent(reason)}` : "");
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}${sep}${qs}`, "Cache-Control": "no-store" },
  });
}

// When we can't identify the org (bad/expired state) there's no deep link to
// return to, so give the human in the browser something readable. Plain text —
// the shared domain won't render HTML.
function plain(message: string, status = 400) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (!state) {
    logError("missing_state", new Error("no state"), {});
    return plain(
      "This link is missing information. Please start again from Zanbi → Settings → Google Drive Backup.",
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin: SupabaseClient = createClient(supabaseUrl, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The state is the ONLY thing tying this request to an org.
  const { data: conn, error: connErr } = await admin
    .from("drive_connections")
    .select("org_sk, oauth_verifier, oauth_return_to, oauth_expires_at, status")
    .eq("oauth_state", state)
    .maybeSingle();
  if (connErr) {
    logError("connection_lookup_failed", connErr, {});
    return plain("Something went wrong on our side. Please try again.", 500);
  }
  if (!conn) {
    // Already consumed, or never ours. Don't leak which.
    logError("unknown_state", new Error("no pending connection"), {});
    return plain(
      "This connection link is no longer valid. Please start again from Zanbi → Settings → Google Drive Backup.",
    );
  }

  const orgSk = conn.org_sk as string;
  const returnTo = (conn.oauth_return_to as string | null) ?? null;

  const expired = conn.oauth_expires_at
    ? new Date(conn.oauth_expires_at as string).getTime() < Date.now()
    : true;
  if (expired) {
    await admin
      .from("drive_connections")
      .update({
        oauth_state: null,
        oauth_verifier: null,
        oauth_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("org_sk", orgSk);
    logInfo("state_expired", { orgSk });
    return redirectToApp(returnTo, "error", "expired");
  }

  // Consume the state immediately — single use, whatever happens next.
  const clearHandshake = {
    oauth_state: null,
    oauth_verifier: null,
    oauth_expires_at: null,
    updated_at: new Date().toISOString(),
  };

  // The owner tapped Cancel / denied the scope on Google's screen.
  if (googleError || !code) {
    await admin
      .from("drive_connections")
      .update(clearHandshake)
      .eq("org_sk", orgSk);
    logInfo("consent_declined", { orgSk, googleError });
    return redirectToApp(
      returnTo,
      "error",
      googleError === "access_denied" ? "declined" : "no_code",
    );
  }

  try {
    const { refreshToken, accessToken } = await exchangeCode({
      code,
      verifier: (conn.oauth_verifier as string) ?? "",
      redirectUri: driveRedirectUri(),
    });

    // No refresh token means we'd have offline access for exactly one hour and
    // the whole background-upload premise breaks. Treat it as a hard failure
    // (it means access_type/prompt didn't take, or Google reused a prior grant).
    if (!refreshToken) {
      await admin
        .from("drive_connections")
        .update({
          ...clearHandshake,
          status: "error",
          last_error: "Google did not return offline access. Please try again.",
        })
        .eq("org_sk", orgSk);
      logError("no_refresh_token", new Error("missing refresh_token"), { orgSk });
      return redirectToApp(returnTo, "error", "no_offline_access");
    }

    // Vault, via the service-role-only RPC. The token never touches our tables
    // and never leaves the server.
    const { data: secretId, error: vaultErr } = await admin.rpc(
      "drive_secret_put",
      { p_org_sk: orgSk, p_token: refreshToken },
    );
    if (vaultErr) {
      logError("vault_put_failed", vaultErr, { orgSk });
      await admin
        .from("drive_connections")
        .update({
          ...clearHandshake,
          status: "error",
          last_error: "Couldn't securely store the Google connection.",
        })
        .eq("org_sk", orgSk);
      return redirectToApp(returnTo, "error", "storage_failed");
    }

    // Label only — a failure here must not block the connection.
    const info = accessToken
      ? await fetchAccountInfo(accessToken)
      : { email: null };

    const { error: saveErr } = await admin
      .from("drive_connections")
      .update({
        ...clearHandshake,
        status: "connected",
        backup_enabled: true,
        google_email: info.email,
        secret_id: secretId ?? null,
        connected_at: new Date().toISOString(),
        last_error: null,
        oauth_return_to: null,
      })
      .eq("org_sk", orgSk);
    if (saveErr) {
      logError("connection_save_failed", saveErr, { orgSk });
      return redirectToApp(returnTo, "error", "storage_failed");
    }

    logInfo("connected", { orgSk, hasEmail: !!info.email });
    return redirectToApp(returnTo, "ok");
  } catch (e) {
    logError("exchange_failed", e, { orgSk });
    await admin
      .from("drive_connections")
      .update({
        ...clearHandshake,
        status: "error",
        last_error: e instanceof Error ? e.message : String(e),
      })
      .eq("org_sk", orgSk);
    return redirectToApp(returnTo, "error", "exchange_failed");
  }
});
