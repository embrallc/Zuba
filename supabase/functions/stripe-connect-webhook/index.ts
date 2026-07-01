// stripe-connect-webhook Edge Function.
//
// MUST be deployed with --no-verify-jwt (Stripe holds no Supabase JWT).
// Authentication is the Stripe webhook HMAC signature, verified with
// STRIPE_WEBHOOK_SECRET via constructEventAsync + the Web Crypto provider
// (Deno has no node:crypto). Always returns 200 for understood events so
// Stripe doesn't retry forever; signature failures return 400.
//
// Direct-charge model: Checkout Sessions live on the connected account, but the
// platform webhook receives their events (with event.account set). We look our
// row up by the globally-unique session id, so we don't need event.account for
// payments. account.updated mirrors the connected account's capability flags.
//
// Handled:
//   checkout.session.completed / async_payment_succeeded → paid (if payment_status paid)
//   checkout.session.expired                             → expired
//   charge.refunded                                      → refunded (mirror only)
//   account.updated                                      → mirror org capabilities

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { getStripe, Stripe } from "../_shared/stripe.ts";
import {
  applyCheckoutStatus,
  markInspectionPaid,
  mirrorAccountCapabilities,
} from "../_shared/stripeSync.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[stripe-connect-webhook]";

function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(`${TAG} ${event}`, JSON.stringify(fields));
}
function logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error: err instanceof Error ? err.message : (anyErr?.message ?? String(err)),
      code: anyErr?.code,
    }),
  );
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Fire the reconciler without blocking the 200 back to Stripe. EdgeRuntime
// .waitUntil keeps the function alive until the (possibly slow: render+email)
// reconcile finishes; correctness is also backstopped by the pg_cron sweep.
function fireReconcile(inspectionSk: string) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const p = fetch(`${url}/functions/v1/reconcile-inspection`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inspectionSk }),
  })
    .then((r) => r.text())
    .catch((e) => logError("reconcile_failed", e, { inspectionSk }));
  const er = (globalThis as Record<string, unknown>).EdgeRuntime as
    | { waitUntil?: (pr: Promise<unknown>) => void }
    | undefined;
  if (er?.waitUntil) er.waitUntil(p);
  return p;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    logError("misconfigured", new Error("STRIPE_WEBHOOK_SECRET not set"));
    return json({ error: "server_misconfigured" }, 500);
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return json({ error: "no_signature" }, 400);

  const rawBody = await req.text();
  const stripe = getStripe();
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      secret,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    logError("bad_signature", e);
    return json({ error: "bad_signature" }, 400);
  }

  const admin: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const eventMs = Number(event.created ?? 0) * 1000 || Date.now();
  logInfo("event", { type: event.type, id: event.id, account: event.account });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== "paid") {
          // Async method not yet confirmed — wait for async_payment_succeeded.
          logInfo("session_unpaid", { id: session.id, ps: session.payment_status });
          return json({ ok: true, skipped: "unpaid" });
        }
        const res = await applyCheckoutStatus(admin, {
          sessionId: session.id,
          status: "paid",
          paymentIntentId:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
          eventMs,
        });
        if (!res.ok) {
          logError("apply_failed", new Error(res.error), { id: session.id });
          return json({ error: res.error }, 500);
        }
        if (res.inspectionSk) {
          const m = await markInspectionPaid(admin, res.inspectionSk);
          if (!m.ok) logError("mark_paid_failed", new Error(m.error), { sk: res.inspectionSk });
          // Release a held report (or send now) — non-blocking so Stripe gets
          // its 200 promptly; the cron sweep backstops if this is interrupted.
          fireReconcile(res.inspectionSk);
        }
        logInfo("paid", { id: session.id, inspectionSk: res.inspectionSk, skipped: res.skipped });
        return json({ ok: true });
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const res = await applyCheckoutStatus(admin, {
          sessionId: session.id,
          status: "expired",
          eventMs,
        });
        if (!res.ok) return json({ error: res.error }, 500);
        logInfo("expired", { id: session.id });
        return json({ ok: true });
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
        if (pi) {
          const { data: row } = await admin
            .from("payment_requests")
            .select("stripe_session_id, last_event_ms")
            .eq("stripe_payment_intent_id", pi)
            .maybeSingle();
          if (row?.stripe_session_id) {
            await applyCheckoutStatus(admin, {
              sessionId: row.stripe_session_id,
              status: "refunded",
              eventMs,
            });
          }
        }
        logInfo("refunded", { pi });
        return json({ ok: true });
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        const res = await mirrorAccountCapabilities(admin, account);
        if (!res.ok) logError("account_mirror_failed", new Error(res.error), { id: account.id });
        logInfo("account_updated", {
          id: account.id,
          charges: account.charges_enabled,
          missing: res.missing ?? false,
        });
        return json({ ok: true });
      }

      default:
        return json({ ok: true, ignored: event.type });
    }
  } catch (e) {
    logError("handler_error", e, { type: event.type });
    return json({ error: "handler_error" }, 500);
  }
});
