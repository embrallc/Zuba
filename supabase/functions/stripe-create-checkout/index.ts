// stripe-create-checkout Edge Function.
//
// Any inspector in the org may bill one of their org's inspections. Creates a
// Stripe Checkout Session as a DIRECT CHARGE on the org's connected account
// (Stripe-Account header), with a 1% application fee to the platform. Mirrors
// the session into payment_requests and flips the inspection to
// payment_state='requested'. The returned checkout_url is shared to the client.
//
// Used by both "Request Payment" and "Resend": if a still-open session exists
// for the inspection we return it instead of minting a duplicate.
//
// Body: { inspectionSk: string, amountCents?: number }
// Returns: { checkoutUrl, status, amountCents, reused }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { getStripe } from "../_shared/stripe.ts";
import { channelRecipients, sendEmail } from "../_shared/email.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[stripe-create-checkout]";
const MIN_CENTS = 50; // Stripe USD minimum charge ($0.50)
const FEE_RATE = 0.01; // 1% platform fee

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

function clientLabel(insp: Record<string, unknown>) {
  const name = (insp.full_name as string) || "";
  const addr = [insp.address_line1, insp.city, insp.state]
    .filter(Boolean)
    .join(", ");
  return [name, addr].filter(Boolean).join(" — ") || "Home inspection";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient: SupabaseClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  const admin: SupabaseClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: { inspectionSk?: string; amountCents?: number } = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const inspectionSk = body.inspectionSk;
  if (!inspectionSk) return json({ error: "missing_inspection" }, 400);

  // ── Load inspection + verify the caller shares its org ──────────────────────
  const { data: insp, error: inspErr } = await admin
    .from("inspections")
    .select(
      "inspection_sk, user_id, full_name, address_line1, city, state, email, report_recipients, _version",
    )
    .eq("inspection_sk", inspectionSk)
    .maybeSingle();
  if (inspErr) {
    logError("inspection_lookup_failed", inspErr, { inspectionSk });
    return json({ error: "db_error" }, 500);
  }
  if (!insp) return json({ error: "inspection_not_found" }, 404);

  // Caller's org and the inspection owner's org must match.
  const { data: caller, error: callerErr } = await admin
    .from("users")
    .select("org_sk")
    .eq("id", user.id)
    .single();
  if (callerErr || !caller?.org_sk) return json({ error: "no_org" }, 400);

  const { data: owner, error: ownerErr } = await admin
    .from("users")
    .select("org_sk")
    .eq("id", insp.user_id)
    .maybeSingle();
  if (ownerErr) {
    logError("owner_lookup_failed", ownerErr, { inspectionSk });
    return json({ error: "db_error" }, 500);
  }
  if (!owner?.org_sk || owner.org_sk !== caller.org_sk) {
    return json({ error: "forbidden" }, 403);
  }
  const orgSk = caller.org_sk as string;

  // ── Org connected-account guard ─────────────────────────────────────────────
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("stripe_account_id, stripe_charges_enabled, auto_send_invoice")
    .eq("org_sk", orgSk)
    .single();
  if (orgErr) {
    logError("org_lookup_failed", orgErr, { orgSk });
    return json({ error: "db_error" }, 500);
  }
  if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
    // UI branches: owner → finish onboarding; inspector → ask the owner.
    return json({ error: "onboarding_incomplete" }, 422);
  }
  const accountId = org.stripe_account_id as string;

  // Auto-send invoice: when the owner toggle is on, email the payment link to
  // whoever is subscribed to the INVOICE channel (defaults to just the payer —
  // we don't flood agents/others who only want the report). The amount lives on
  // Stripe's page; we only deliver the link.
  const recipients = channelRecipients(
    insp.report_recipients,
    insp.email,
    "invoice",
  );
  const autoSendInvoice = !!org.auto_send_invoice;

  async function autoEmailInvoice(checkoutUrl: string): Promise<boolean> {
    if (!autoSendInvoice || recipients.length === 0) return false;
    const addr = [insp.address_line1, insp.city, insp.state].filter(Boolean).join(", ");
    const who = insp.full_name || "there";
    const subject = `Your invoice${addr ? ` — ${addr}` : ""}`;
    const text =
      `Hi ${who},\n\nYour inspector has sent you an invoice. View the amount and ` +
      `pay securely here:\n${checkoutUrl}\n\nThank you!`;
    const html =
      `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5">` +
      `<p>Hi ${who},</p>` +
      `<p>Your inspector has sent you an invoice${addr ? ` for <strong>${addr}</strong>` : ""}.</p>` +
      `<p><a href="${checkoutUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">View &amp; pay invoice</a></p>` +
      `<p style="color:#888;font-size:13px">Or paste this link into your browser:<br>${checkoutUrl}</p>` +
      `</div>`;
    const r = await sendEmail({ to: recipients, subject, html, text });
    if (!r.ok) logError("invoice_email_failed", new Error(r.error), { inspectionSk });
    return r.ok;
  }

  const stripe = getStripe();

  // ── Reuse a still-open session if one exists (Resend) ───────────────────────
  const { data: openReqs } = await admin
    .from("payment_requests")
    .select("payment_request_sk, stripe_session_id, checkout_url, amount_cents, status")
    .eq("inspection_sk", inspectionSk)
    .in("status", ["created", "open"])
    .order("created_at", { ascending: false })
    .limit(1);
  const reusable = openReqs?.[0];
  if (reusable?.stripe_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(
        reusable.stripe_session_id,
        undefined,
        { stripeAccount: accountId },
      );
      if (existing.status === "open" && existing.url) {
        const autoSent = await autoEmailInvoice(existing.url);
        logInfo("reused_session", { inspectionSk, sessionId: existing.id, autoSent });
        return json({
          checkoutUrl: existing.url,
          status: "open",
          amountCents: reusable.amount_cents,
          reused: true,
          autoSent,
        });
      }
    } catch (e) {
      // Couldn't retrieve (expired/deleted) — fall through and mint a new one.
      logInfo("reuse_failed", { inspectionSk, err: (e as Error)?.message });
    }
  }

  // ── Mint a new Checkout Session ─────────────────────────────────────────────
  const amountCents = Math.round(Number(body.amountCents ?? 0));
  if (!Number.isFinite(amountCents) || amountCents < MIN_CENTS) {
    return json({ error: "invalid_amount", minCents: MIN_CENTS }, 400);
  }
  const feeCents = Math.max(0, Math.round(amountCents * FEE_RATE));
  const returnBase = `${url}/functions/v1/stripe-return`;

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: clientLabel(insp) },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: { application_fee_amount: feeCents },
        success_url: `${returnBase}?status=paid`,
        cancel_url: `${returnBase}?status=canceled`,
        metadata: { inspection_sk: inspectionSk, org_sk: orgSk },
      },
      { stripeAccount: accountId },
    );
  } catch (e) {
    logError("session_create_failed", e, { inspectionSk, orgSk });
    return json({ error: "stripe_error", detail: (e as Error)?.message }, 502);
  }

  // ── Mirror into payment_requests (service role) ─────────────────────────────
  const nowIso = new Date().toISOString();
  const { error: insErr } = await admin.from("payment_requests").insert({
    inspection_sk: inspectionSk,
    org_sk: orgSk,
    created_by: user.id,
    stripe_session_id: session.id,
    stripe_payment_intent_id:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
    checkout_url: session.url,
    amount_cents: amountCents,
    application_fee_cents: feeCents,
    currency: "usd",
    status: "open",
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (insErr) {
    logError("mirror_insert_failed", insErr, { inspectionSk, sessionId: session.id });
    // The session exists in Stripe; the webhook will still reconcile it. Don't
    // fail the caller — they have a usable link.
  }

  // ── Roll the inspection to 'requested' + bump _version so devices pull it ───
  const nextVersion = Number(insp._version ?? 1) + 1;
  await admin
    .from("inspections")
    .update({
      payment_state: "requested",
      _version: nextVersion,
      _last_changed_at: Date.now(),
    })
    .eq("inspection_sk", inspectionSk)
    .then(({ error }) => {
      if (error) logError("inspection_state_update_failed", error, { inspectionSk });
    });

  const autoSent = await autoEmailInvoice(session.url!);

  logInfo("session_created", {
    inspectionSk,
    orgSk,
    sessionId: session.id,
    amountCents,
    feeCents,
    autoSent,
  });
  return json({
    checkoutUrl: session.url,
    status: "open",
    amountCents,
    reused: false,
    autoSent,
  });
});
