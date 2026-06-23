// stripe-return Edge Function.
//
// The single https landing page for every Stripe hosted flow, because Stripe
// rejects custom app schemes in return/success/cancel URLs. Two modes:
//
//  1. Onboarding return — ?to=<urlencoded app deep link>. The inspector's
//     in-app browser loads this and we bounce to the deep link, which
//     WebBrowser.openAuthSessionAsync detects to close the session.
//
//  2. Checkout success/cancel — ?status=paid|canceled (no `to`). The *client*
//     (not the inspector) is paying in a plain mobile browser with no app, so
//     we render a friendly standalone message. Payment truth comes from the
//     webhook, not this page.
//
// Deploy with --no-verify-jwt: Stripe redirects here with a plain GET.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ALLOWED_SCHEMES = ["clientmanagment://", "exp://", "exps://"];

function shell(title: string, bodyHtml: string, headExtra = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
${headExtra}
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, sans-serif; text-align: center; padding: 3rem 1.5rem; color: #1c1c1e; background: #f7f7f9; }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 2rem 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: .25rem 0 .5rem; }
  p { color: #555; line-height: 1.45; margin: .25rem 0; }
  a { color: #2f6fed; font-weight: 600; text-decoration: none; }
  .check { font-size: 2.5rem; }
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
}

serve((req) => {
  const url = new URL(req.url);
  const to = url.searchParams.get("to");
  const status = url.searchParams.get("status");

  // Mode 1: bounce into the app (onboarding return).
  if (to && ALLOWED_SCHEMES.some((p) => to.startsWith(p))) {
    const hrefSafe = to.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const html = shell(
      "Returning to Kensa…",
      `<p>Returning to Kensa…</p><p><a href="${hrefSafe}">Tap here if the app doesn't reopen.</a></p>`,
      `<script>setTimeout(function(){ location.replace(${JSON.stringify(to)}); }, 50);</script>`,
    );
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Mode 2: standalone status page for the client who paid the link.
  let body: string;
  if (status === "paid") {
    body = `<div class="check">✅</div><h1>Payment received</h1>
      <p>Thank you! Your inspector has been notified. You can close this window.</p>`;
  } else if (status === "canceled") {
    body = `<h1>Payment canceled</h1>
      <p>No charge was made. If this was a mistake, reopen the payment link your inspector sent you.</p>`;
  } else {
    body = `<h1>All set</h1><p>You can close this window.</p>`;
  }
  return new Response(shell("Kensa", body), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
