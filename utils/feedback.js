import { LOG_DEVICE_META } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Character cap for a single feedback note. Enforced in the UI (TextInput
// maxLength + counter) and again by a DB check constraint (<= 1000, with
// headroom) as defense in depth.
export const FEEDBACK_MAX = 750;

// Submit one Ideas/Feedback/Issues note. Inserts a single row into the
// append-only `feedback` table. user_id is filled server-side by the column
// default (auth.uid()), so we never send it — RLS only allows a row whose
// user_id matches the caller. Returns { ok, error } (error is a short code:
// "empty" | "too_long" | "offline" | <supabase message>).
export async function submitFeedback({ body, orgSk } = {}) {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, error: "empty" };
  if (text.length > FEEDBACK_MAX) return { ok: false, error: "too_long" };
  if (!isOnline()) return { ok: false, error: "offline" };

  const { error } = await supabase.from("feedback").insert({
    body: text,
    org_sk: orgSk ?? null,
    app_version: LOG_DEVICE_META?.app_version ?? null,
    platform: LOG_DEVICE_META?.platform ?? null,
  });

  if (error) return { ok: false, error: error.message ?? "insert_failed" };
  return { ok: true };
}
