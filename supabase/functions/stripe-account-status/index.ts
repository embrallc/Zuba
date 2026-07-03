// stripe-account-status Edge Function.
//
// Owner-only. Retrieves the org's connected account from Stripe and mirrors its
// capability flags (charges_enabled / payouts_enabled / details_submitted) onto
// the organizations row via the service role. Called right after the owner
// returns from onboarding (REST-as-truth — don't wait for the account.updated
// webhook), and any time the Payments screen wants a fresh status.
//
// Returns: { chargesEnabled, payoutsEnabled, detailsSubmitted, hasAccount,
//            disabledReason, requirementsDue }. The last two let the Payments
//            screen tell the owner exactly what Stripe still needs when the
//            account is created but charges aren't enabled yet ("Restricted").

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "npm:@supabase/supabase-js@2";
import { getStripe } from "../_shared/stripe.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[stripe-account-status]";

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
      details: anyErr?.details,
    }),
  );
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

  const { data: me, error: meErr } = await admin
    .from("users")
    .select("user_profile, org_sk")
    .eq("id", user.id)
    .single();
  if (meErr || !me?.org_sk) return json({ error: "no_org" }, 400);
  if (me.user_profile !== "owner") return json({ error: "owner_only" }, 403);
  const orgSk = me.org_sk as string;

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("stripe_account_id")
    .eq("org_sk", orgSk)
    .single();
  if (orgErr) {
    logError("org_lookup_failed", orgErr, { orgSk });
    return json({ error: "db_error" }, 500);
  }
  const accountId: string | null = org?.stripe_account_id ?? null;
  if (!accountId) {
    return json({
      hasAccount: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
  }

  const stripe = getStripe();
  try {
    const acct = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = !!acct.charges_enabled;
    const payoutsEnabled = !!acct.payouts_enabled;
    const detailsSubmitted = !!acct.details_submitted;
    // Why charges are blocked + which fields Stripe is waiting on. `currently_due`
    // is what's needed to unblock progress right now; fall back to `past_due` /
    // `eventually_due` so the owner still sees something actionable. These are
    // live-only (not mirrored to the org row) — the client renders them as a hint.
    const req = (acct.requirements ?? {}) as {
      disabled_reason?: string | null;
      currently_due?: string[] | null;
      past_due?: string[] | null;
      eventually_due?: string[] | null;
    };
    const disabledReason = req.disabled_reason ?? null;
    const requirementsDue =
      (req.currently_due && req.currently_due.length ? req.currently_due : null) ??
      (req.past_due && req.past_due.length ? req.past_due : null) ??
      req.eventually_due ??
      [];

    const { error: upErr } = await admin
      .from("organizations")
      .update({
        stripe_charges_enabled: chargesEnabled,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_details_submitted: detailsSubmitted,
      })
      .eq("org_sk", orgSk);
    if (upErr) {
      logError("persist_status_failed", upErr, { orgSk });
      // Non-fatal — still return the truth we fetched.
    }

    logInfo("status_synced", {
      orgSk,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      disabledReason,
      dueCount: requirementsDue.length,
    });
    return json({
      hasAccount: true,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      disabledReason,
      requirementsDue,
    });
  } catch (e) {
    logError("stripe_error", e, { orgSk, accountId });
    return json({ error: "stripe_error" }, 502);
  }
});
