import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// True only when both creds are present. createClient throws on undefined
// url/key, which would crash-loop the container at boot and hide the real cause
// — so we guard it and let the server start in a "misconfigured" state instead.
export const isConfigured = !!(SUPABASE_URL && SERVICE_ROLE_KEY);

if (!isConfigured) {
  console.error(
    "[worker] MISCONFIGURED: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
      "Server will start, /health reports configured:false, and report requests return 503.",
  );
}

// Admin client. The service-role key bypasses RLS — used for every data write
// (report_jobs, inspection_reports, app_logs, Storage) AND for validating the
// caller's Supabase JWT via admin.auth.getUser(jwt). null when unconfigured.
export const admin = isConfigured
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// Validate a Supabase access token. Returns the auth user, or null if the token
// is missing/expired/invalid. getUser(jwt) verifies the token server-side
// against the Auth API (it uses the passed jwt, not the client's key).
export async function getUserFromJwt(jwt) {
  if (!admin || !jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error) return null;
    return data?.user ?? null;
  } catch (_) {
    return null;
  }
}
