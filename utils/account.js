import { Linking, Platform } from "react-native";
import { logError } from "../db/logs";
import { supabase } from "./supabase";

// Where users manage (and cancel) their App Store / Play subscription.
// Neither we nor RevenueCat can cancel an Apple subscription on the user's
// behalf — Apple guideline 5.1.1(v) requires us to TELL them that on account
// deletion and point them here.
export const MANAGE_SUBSCRIPTIONS_URL =
  Platform.OS === "ios"
    ? "https://apps.apple.com/account/subscriptions"
    : "https://play.google.com/store/account/subscriptions";

export function openManageSubscriptions() {
  Linking.openURL(MANAGE_SUBSCRIPTIONS_URL).catch((e) =>
    logError(e, "openManageSubscriptions"),
  );
}

// Invoke the delete-account edge function and normalize its result.
// Resolves with { status: "full_org_deleted" | "user_only_deleted" |
// "blocked_sole_owner", message? }. Throws an Error whose message is the
// real server-side reason (parsed out of the FunctionsHttpError body).
export async function requestAccountDeletion() {
  const { data, error } = await supabase.functions.invoke("delete-account");
  if (error) {
    let detail = error.message ?? "Could not delete account.";
    try {
      const body = await error.context?.json?.();
      if (body?.error) detail = body.error;
    } catch (_) {}
    throw new Error(detail);
  }
  return data ?? {};
}
