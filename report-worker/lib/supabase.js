import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  // Fail loud at boot — a worker with no Supabase credentials can't do anything.
  console.error(
    "[worker] FATAL: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env",
  );
}

// Admin client. The service-role key bypasses RLS — used for every data write
// (report_jobs, inspection_reports, app_logs, Storage) AND for validating the
// caller's Supabase JWT via admin.auth.getUser(jwt).
export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Validate a Supabase access token. Returns the auth user, or null if the token
// is missing/expired/invalid. getUser(jwt) verifies the token server-side
// against the Auth API (it uses the passed jwt, not the client's key).
export async function getUserFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error) return null;
    return data?.user ?? null;
  } catch (_) {
    return null;
  }
}
