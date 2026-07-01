// Client wrapper for the ai-rewrite Edge Function.
//
// Sends a rough field note (+ light context: the field label, its section, and
// the sibling answers in the same instance) and returns a professional rewrite
// the caller shows for review. The function holds the Gemini key — we never
// call Google from the device.

import { logError, logEvent } from "../db/logs";
import { supabase } from "./supabase";

// Throws an Error whose `.code` is the server reason ("rate_limited",
// "ai_failed", etc.) when available, so callers can tailor the message.
export async function requestRewrite({
  text,
  fieldLabel,
  sectionTitle,
  context,
  regenerate = false,
}) {
  const { data, error } = await supabase.functions.invoke("ai-rewrite", {
    body: { text, fieldLabel, sectionTitle, context, regenerate },
  });

  if (error) {
    // Pull the server-side reason out of the FunctionsHttpError wrapper.
    let code = null;
    try {
      const reason = await error.context?.json?.();
      code = reason?.error ?? null;
    } catch (_) {}
    logError(error, `utils/aiRewrite.requestRewrite code=${code ?? "?"}`);
    const e = new Error(code ?? "ai_rewrite_failed");
    e.code = code;
    throw e;
  }

  const rewrite = typeof data?.rewrite === "string" ? data.rewrite.trim() : "";
  if (!rewrite) {
    const e = new Error("empty_rewrite");
    e.code = "empty_rewrite";
    throw e;
  }
  logEvent("airewrite.success", { regenerate });
  return rewrite;
}

// User-facing copy for the failure codes the sheet/Alert may surface.
export function rewriteErrorMessage(code) {
  switch (code) {
    case "rate_limited":
      return "You've reached today's AI Rewrite limit. Try again tomorrow.";
    case "ai_failed":
    case "empty_rewrite":
      return "The rewrite didn't come through. Please try again.";
    case "server_misconfigured":
      return "AI Rewrite isn't available right now.";
    default:
      return "Couldn't reach AI Rewrite. Check your connection and try again.";
  }
}
