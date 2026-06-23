// stripe-connect-onboard Edge Function.
//
// Owner-only. Creates (or reuses) the org's Standard connected account and
// returns a hosted Account Link the app opens for onboarding. The Stripe secret
// key never leaves the server; the client only ever opens the returned URL and
// the inspector enters their banking details on Stripe's hosted pages.
//
// Body: { returnUrl?, refreshUrl? } (deep links). Returns: { url }.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { getStripe } from "../_shared/stripe.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[stripe-connect-onboard]";
const DEFAULT_RETURN = "clientmanagment://payments-return";

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
  if (meErr || !me?.org_sk) {
    logError("user_lookup_failed", meErr ?? new Error("no org"), { user_id: user.id });
    return json({ error: "no_org" }, 400);
  }
  if (me.user_profile !== "owner") return json({ error: "owner_only" }, 403);
  const orgSk = me.org_sk as string;

  let body: any = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const returnUrl: string = body?.returnUrl || DEFAULT_RETURN;
  const refreshUrl: string = body?.refreshUrl || returnUrl;

  const stripe = getStripe();
  // Track which step failed so the (safe, non-secret) Stripe message can be
  // surfaced to the owner — most first-run failures are config issues
  // (Connect not enabled, invalid return URL) that the message names exactly.
  let step = "org_lookup";
  try {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("stripe_account_id")
      .eq("org_sk", orgSk)
      .single();
    if (orgErr) {
      logError("org_lookup_failed", orgErr, { orgSk });
      return json({ error: "db_error" }, 500);
    }

    let accountId: string | null = org?.stripe_account_id ?? null;
    if (!accountId) {
      step = "account_create";
      const acct = await stripe.accounts.create({
        type: "standard",
        metadata: { org_sk: orgSk },
      });
      accountId = acct.id;
      const { error: upErr } = await admin
        .from("organizations")
        .update({ stripe_account_id: accountId })
        .eq("org_sk", orgSk);
      if (upErr) {
        logError("persist_account_failed", upErr, { orgSk, accountId });
        return json({ error: "db_error" }, 500);
      }
      logInfo("account_created", { orgSk, accountId });
    }

    step = "account_link";
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });
    logInfo("link_created", { orgSk, accountId });
    return json({ url: link.url });
  } catch (e) {
    logError("stripe_error", e, { orgSk, step });
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "stripe_error", step, detail }, 502);
  }
});
