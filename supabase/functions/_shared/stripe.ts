// Shared Stripe client for the Connect Edge Functions.
//
// One configured instance, using the Web-Crypto-friendly fetch HTTP client
// (Deno has no node:http). The secret key is a Supabase secret and never leaves
// the server. Webhook signature verification uses Stripe.createSubtleCryptoProvider()
// at the call site (see stripe-connect-webhook).

import Stripe from "npm:stripe@^17.7.0";

declare const Deno: { env: { get(name: string): string | undefined } };

export function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export { Stripe };
