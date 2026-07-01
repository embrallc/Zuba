import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Share } from "react-native";
import { setInspectionPaymentStateLocal } from "../db/inspections";
import { logError, logEvent } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { pushInspection } from "./sync";
import { supabase } from "./supabase";

// Client-side wrappers for the Stripe Connect Edge Functions. All Stripe API
// work + the secret key live server-side; these just invoke the functions and
// open the hosted URLs. Errors are unwrapped from the FunctionsHttpError
// envelope (same pattern as utils/reports.js) and rethrown with a presentable
// message.

const INVOKE_TIMEOUT_MS = 30000;

async function invoke(name, body) {
  // Race the call against a timeout so a hung request recovers the UI with a
  // clear message instead of spinning forever.
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
    logError(e, `utils/payments.invoke ${name} (timeout/transport)`);
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
      // Prefer the human-readable detail (e.g. the exact Stripe message) when
      // the function provides one; fall back to the machine code.
      detail = parsed?.detail || parsed?.error || code;
    } catch (_) {}
    logError(error, `utils/payments.invoke ${name} code="${code}" detail="${detail}"`);
    const err = new Error(detail);
    err.code = code;
    throw err;
  }
  return data;
}

// The https landing page Stripe redirects to after a hosted flow. Stripe
// rejects custom app schemes, so we hand it this public Edge Function URL and
// it bounces back to the app's deep link (which WebBrowser watches for).
function stripeReturnUrl(deepLink) {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  return `${base}/functions/v1/stripe-return?to=${encodeURIComponent(deepLink)}`;
}

// Owner: mint an onboarding Account Link and open it in a secure browser session.
// Resolves with the WebBrowser result ({ type: 'success' | 'cancel' | 'dismiss' });
// the caller should then refresh status to pick up the new capability flags.
export async function startStripeOnboarding() {
  // The deep link WebBrowser watches for to auto-close the session.
  const deepLink = Linking.createURL("payments-return");
  // The https URL Stripe redirects to (it rejects custom schemes); it bounces
  // to deepLink on load.
  const httpsReturn = stripeReturnUrl(deepLink);
  const data = await invoke("stripe-connect-onboard", {
    returnUrl: httpsReturn,
    refreshUrl: httpsReturn,
  });
  if (!data?.url) throw new Error("No onboarding link was returned.");
  return await WebBrowser.openAuthSessionAsync(data.url, deepLink);
}

// Owner: pull the live account status from Stripe (and mirror it server-side).
// Returns { hasAccount, chargesEnabled, payoutsEnabled, detailsSubmitted }.
export async function refreshPaymentStatus() {
  return await invoke("stripe-account-status", {});
}

// Any inspector: create (or reuse) a Stripe Checkout link for an inspection and
// return it. amountCents is required when no open session exists; on Resend the
// server reuses the still-open session and ignores the amount. Optimistically
// flips the in-memory inspection to payment_state='requested' and pushes the
// row so the server state is current. Throws on failure (e.code carries the
// machine reason, e.g. 'onboarding_incomplete').
export async function requestPayment(inspectionSk, amountCents) {
  // Make sure the inspection exists in the cloud BEFORE the server tries to
  // bill it — a just-created inspection may not have synced yet, and the
  // checkout function looks the row up by sk (else `inspection_not_found`).
  // Pushing here is safe: pushInspection omits the server-owned payment
  // columns, so it can't roll back a payment_state the server may later set.
  await pushInspection(inspectionSk);

  const data = await invoke("stripe-create-checkout", { inspectionSk, amountCents });
  if (!data?.checkoutUrl) throw new Error("No payment link was returned.");

  logEvent("payment.requested", { sk: inspectionSk, amountCents });

  // Optimistic UI: the server already set 'requested' + bumped _version. Reflect
  // it BOTH in SQLite (so the archive badge + a later reopen keep showing it) and
  // in the active store (snappy ribbon), before the authoritative value syncs.
  // We deliberately do NOT pushInspection here: there's nothing device-owned to
  // push, and pushing our stale _version would roll back the server's bump and
  // strand the pulled payment_state.
  try {
    await setInspectionPaymentStateLocal(inspectionSk, "requested");
    const store = useInspectionStore.getState();
    const current = store.getById?.(inspectionSk) ?? null;
    if (current) store.update({ ...current, PaymentState: "requested" });
  } catch (_) {}

  return data; // { checkoutUrl, status, amountCents, reused }
}

// Share a checkout link via the OS share sheet (SMS / Mail / etc.).
export async function shareCheckoutLink(checkoutUrl, clientName) {
  const who = clientName ? ` for ${clientName}` : "";
  try {
    await Share.share({
      message: `Here is your secure payment link${who}: ${checkoutUrl}`,
      url: checkoutUrl,
    });
  } catch (e) {
    logError(e, "utils/payments.shareCheckoutLink");
  }
}
