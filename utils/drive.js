import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { logError, logEvent } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Client-side wrappers for the Google Drive Backup Edge Functions. Exactly the
// shape utils/payments.js uses for Stripe Connect: all OAuth work, the client
// secret, and the refresh token live server-side; the app only opens the hosted
// URL Google serves and reads back a status. Errors are unwrapped from the
// FunctionsHttpError envelope and rethrown with a presentable message.

const INVOKE_TIMEOUT_MS = 30000;

async function invoke(name, body) {
  // Offline: fail instantly instead of waiting out the timeout below.
  if (!isOnline()) {
    const err = new Error("You're offline — connect to the internet and try again.");
    err.code = "offline";
    throw err;
  }
  let result;
  try {
    result = await Promise.race([
      supabase.functions.invoke(name, { body: body ?? {} }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("The request timed out. Check your connection and try again."),
            ),
          INVOKE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (e) {
    logError(e, `utils/drive.invoke ${name} (timeout/transport)`);
    const err = new Error(e?.message || "Request failed. Please try again.");
    err.code = "timeout";
    throw err;
  }
  const { data, error } = result;
  if (error) {
    let code = error.message ?? "Something went wrong.";
    let detail = code;
    try {
      const parsed = await error.context?.json?.();
      if (parsed?.error) code = parsed.error;
      detail = parsed?.detail || parsed?.error || code;
    } catch (_) {}
    logError(error, `utils/drive.invoke ${name} code="${code}" detail="${detail}"`);
    const err = new Error(friendlyError(code, detail));
    err.code = code;
    throw err;
  }
  return data;
}

function friendlyError(code, detail) {
  switch (code) {
    case "owner_only":
      return "Only the organization owner can manage Google Drive backup.";
    case "no_org":
      return "We couldn't find your organization. Please sign out and back in.";
    case "google_not_configured":
      return "Google Drive isn't set up on the server yet. Please contact support.";
    case "disconnect_failed":
      return "We couldn't fully disconnect Google Drive. Please try again.";
    default:
      return detail || "Something went wrong. Please try again.";
  }
}

// Why the browser came back without a connection. These codes are set by
// drive-oauth-callback; keep them in sync with that function.
function friendlyReason(reason) {
  switch (reason) {
    case "declined":
      return "You cancelled before granting access, so nothing was connected.";
    case "expired":
      return "That sign-in took too long and expired. Please try again.";
    case "no_offline_access":
      return "Google didn't grant ongoing access. Please try again and approve the request.";
    case "storage_failed":
      return "We couldn't securely store the connection. Please try again.";
    case "exchange_failed":
      return "Google couldn't complete the sign-in. Please try again.";
    case "no_code":
      return "Google didn't return a sign-in result. Please try again.";
    default:
      return null; // caller shows nothing for a plain dismiss
  }
}

// Owner: open Google's hosted consent screen in a secure browser session.
// Resolves { ok, dismissed, reason, message }. Google BLOCKS OAuth inside
// embedded webviews, which is why this is openAuthSessionAsync (a real system
// browser sheet) and not an in-app <WebView>.
export async function startDriveConnect() {
  const deepLink = Linking.createURL("drive-return");
  const data = await invoke("drive-connect-start", { returnUrl: deepLink });
  if (!data?.url) throw new Error("No Google sign-in link was returned.");

  const result = await WebBrowser.openAuthSessionAsync(data.url, deepLink);

  // The user swiped the sheet away (or backgrounded it) — not an error.
  if (result?.type !== "success" || !result?.url) {
    return { ok: false, dismissed: true, reason: null, message: null };
  }

  let params = {};
  try {
    params = Linking.parse(result.url)?.queryParams ?? {};
  } catch (e) {
    logError(e, "utils/drive.startDriveConnect parse");
  }
  const ok = params?.status === "ok";
  if (ok) logEvent("drive.connected", {});
  const reason = params?.reason ?? null;
  return {
    ok,
    dismissed: false,
    reason,
    message: ok ? null : friendlyReason(reason),
  };
}

// Owner: connection state + recent backup activity for the org.
export async function getDriveStatus() {
  return await invoke("drive-status", {});
}

// Owner: revoke at Google and delete the stored credential. Files already in
// their Drive are theirs and stay put.
export async function disconnectDrive() {
  const data = await invoke("drive-manage", { action: "disconnect" });
  logEvent("drive.disconnected", {});
  return data;
}

// Owner: re-arm every failed backup for the org and nudge the runner now.
export async function retryFailedBackups() {
  return await invoke("drive-manage", { action: "retry_failed" });
}

// Owner: the master "back up completed inspections" switch.
export async function setDriveBackupEnabled(enabled) {
  return await invoke("drive-manage", { action: "set_enabled", enabled: !!enabled });
}
