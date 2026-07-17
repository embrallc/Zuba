import { Share } from "react-native";
import { logError } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Mints a fresh, private Form & Report Builder link (the server keeps only a
// hash of the token, so the raw link lives only in the returned URL) and hands
// it to the OS share sheet. We deliberately do NOT open it in the phone browser:
// the drag-and-drop builder is built for a computer, so the flow is "email the
// link to yourself, then open it on your PC." Returns { ok, reason }.
export async function shareFormBuilderLink() {
  if (!isOnline()) return { ok: false, reason: "offline" };
  try {
    const { data, error } = await supabase.functions.invoke("form-editor", {
      body: { action: "mint" },
    });
    if (error || !data?.url) throw error ?? new Error("no url returned");
    await Share.share({
      message:
        "Set up your Zanbi inspection form & report — open this on your computer:\n\n" +
        `${data.url}\n\n` +
        "Tip: email this link to yourself, then open it in your computer's " +
        "browser. The drag-and-drop builder works best on a big screen.",
    });
    return { ok: true };
  } catch (e) {
    logError(e, "utils/formBuilder.shareFormBuilderLink");
    return { ok: false, reason: "error" };
  }
}
