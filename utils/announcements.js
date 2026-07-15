import { logError } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Global product announcements (outages / updates / releases). Read-only from the
// client — authored by inserting rows into public.product_notifications via the
// Supabase dashboard. Returns newest-first, or null when it couldn't refresh
// (offline / error) so callers keep whatever they already had.
export async function fetchProductNotifications() {
  if (!isOnline()) return null;
  try {
    const { data, error } = await supabase
      .from("product_notifications")
      .select("id, title, body, category, published_at")
      .order("published_at", { ascending: false })
      .limit(100);
    if (error) {
      logError(error, "utils/announcements.fetchProductNotifications");
      return null;
    }
    return data ?? [];
  } catch (e) {
    logError(e, "utils/announcements.fetchProductNotifications");
    return null;
  }
}
