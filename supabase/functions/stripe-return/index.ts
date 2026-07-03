// stripe-return Edge Function.
//
// The single https landing page for every Stripe hosted flow, because Stripe
// rejects custom app schemes in return/success/cancel URLs. Two modes:
//
//  1. Onboarding return — ?to=<urlencoded app deep link>. We 302-redirect the
//     browser straight to the deep link; expo-web-browser's openAuthSessionAsync
//     (ASWebAuthenticationSession) intercepts the custom-scheme Location and
//     closes the session, handing control back to the app.
//
//  2. Checkout success/cancel — ?status=paid|canceled (no `to`). The *client*
//     (not the inspector) is paying in a plain mobile browser with no app, so
//     we return a short confirmation. Payment truth comes from the webhook,
//     not this page.
//
// ⚠️ The Supabase shared functions domain force-downgrades any text/html response
// to text/plain + `X-Content-Type-Options: nosniff` + a `sandbox` CSP (anti-
// phishing). So we CANNOT serve a styled HTML page or an inline-JS redirect here
// — Safari shows the raw markup as text and the script never runs. Hence a real
// HTTP 302 for mode 1 and plain text for mode 2 (same approach as form-editor).
//
// Deploy with --no-verify-jwt: Stripe redirects here with a plain GET.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ALLOWED_SCHEMES = ["clientmanagment://", "exp://", "exps://"];

serve((req) => {
  const url = new URL(req.url);
  const to = url.searchParams.get("to");
  const status = url.searchParams.get("status");

  // Mode 1: bounce back into the app via a real HTTP redirect to the deep link.
  // The scheme allow-list keeps this from being an open redirect (we only ever
  // send the browser to one of our own app schemes, never an arbitrary https URL).
  if (to && ALLOWED_SCHEMES.some((p) => to.startsWith(p))) {
    return new Response(null, {
      status: 302,
      headers: { Location: to, "Cache-Control": "no-store" },
    });
  }

  // Mode 2: standalone confirmation for the client who paid the link. Plain text
  // (the shared domain won't render HTML); the webhook is the source of truth.
  let msg: string;
  if (status === "paid") {
    msg =
      "Payment received. Thank you! Your inspector has been notified. You can close this window.";
  } else if (status === "canceled") {
    msg =
      "Payment canceled. No charge was made. To try again, reopen the payment link your inspector sent you.";
  } else {
    msg = "All set. You can close this window.";
  }
  return new Response(msg, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
