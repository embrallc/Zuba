// RateLimiter — reusable per-subject rate limiting for Edge Functions.
//
// The limits live in the database (public.rate_limits, one row per "scope"),
// which is the single source of truth: change a limit with SQL and it applies
// on the next call, no deploy. Counting happens in the database too
// (rate_limit_hit), in one atomic statement, so simultaneous calls count exactly.
//
// Use it in any Edge Function that has a service-role client:
//
//   const limiter = new RateLimiter(admin, "mcp");          // a scope in rate_limits
//   const verdict = await limiter.check(userId);            // counts this call
//   if (!verdict.allowed) return limiter.reject(verdict);   // 429 + Retry-After
//
// To limit something new: add a row to public.rate_limits (in a migration),
// then use those three lines with the new scope.
//
// The subject is who gets counted — usually a user id. Never pass a secret
// (like an API key) as the subject: it's stored and logged as-is.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logCloudEvent, logToCloud } from "./logToCloud.ts";

export type RateLimitVerdict = {
  allowed: boolean;
  limitHit: "minute" | "day" | null;
  minuteCalls: number;
  dayCalls: number;
  perMinute: number;
  perDay: number;
  retryAfterSeconds: number | null;
};

// What rate_limit_hit returns (one row).
type HitRow = {
  allowed: boolean;
  limit_hit: "minute" | "day" | null;
  minute_calls: number;
  day_calls: number;
  per_minute: number;
  per_day: number;
  retry_after_seconds: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RateLimiter {
  private admin: SupabaseClient;
  private scope: string;

  constructor(admin: SupabaseClient, scope: string) {
    this.admin = admin;
    this.scope = scope;
  }

  // Counts one call for `subject` and says whether it's allowed.
  //
  // If the check itself fails (database error, no rate_limits row for this
  // scope), the call is ALLOWED and the failure is logged as an error: a
  // broken limiter shouldn't take the feature down with it.
  async check(subject: string): Promise<RateLimitVerdict> {
    const { data, error } = await this.admin
      .rpc("rate_limit_hit", { p_scope: this.scope, p_subject: subject })
      .maybeSingle<HitRow>();

    if (error || !data) {
      const reason = error?.message ?? "rate_limit_hit returned no row";
      console.error(`[rateLimiter:${this.scope}] check failed, allowing the call:`, reason);
      await logToCloud(this.admin, {
        level: "error",
        event: "rate_limit.failed",
        message: reason,
        source: this.source(),
        data: { scope: this.scope },
      });
      return {
        allowed: true,
        limitHit: null,
        minuteCalls: 0,
        dayCalls: 0,
        perMinute: 0,
        perDay: 0,
        retryAfterSeconds: null,
      };
    }

    const verdict: RateLimitVerdict = {
      allowed: data.allowed,
      limitHit: data.limit_hit,
      minuteCalls: data.minute_calls,
      dayCalls: data.day_calls,
      perMinute: data.per_minute,
      perDay: data.per_day,
      retryAfterSeconds: data.retry_after_seconds,
    };

    // Log only the FIRST call over a limit, so a runaway caller can't flood
    // the logs as well.
    if (!verdict.allowed && this.isFirstCallOver(verdict)) {
      console.warn(
        `[rateLimiter:${this.scope}] limit hit`,
        JSON.stringify({ subject, limit: verdict.limitHit }),
      );
      await logCloudEvent(this.admin, this.source(), "rate_limit.exceeded", {
        userId: UUID.test(subject) ? subject : null,
        data: {
          scope: this.scope,
          subject,
          limit: verdict.limitHit,
          minuteCalls: verdict.minuteCalls,
          dayCalls: verdict.dayCalls,
        },
      });
    }

    return verdict;
  }

  // The 429 response for a rejected call, saying how long to wait. Pass extra
  // headers (e.g. CORS) if your function needs them on every response.
  reject(verdict: RateLimitVerdict, headers: Record<string, string> = {}): Response {
    return Response.json(
      {
        error: "rate_limited",
        message: verdict.limitHit === "day"
          ? "Daily limit reached. Try again tomorrow."
          : "Too many requests. Wait a minute, then try again.",
      },
      {
        status: 429,
        headers: { ...headers, "Retry-After": String(verdict.retryAfterSeconds ?? 60) },
      },
    );
  }

  private source(): string {
    return `ratelimit:${this.scope}`;
  }

  private isFirstCallOver(verdict: RateLimitVerdict): boolean {
    return verdict.limitHit === "day"
      ? verdict.dayCalls === verdict.perDay + 1
      : verdict.minuteCalls === verdict.perMinute + 1;
  }
}
