// send-welcome-email Edge Function.
//
// Sends the one-time welcome email to a new OWNER at signup.
// Called by the welcome_email_on_signup trigger on auth.users (via pg_net).
//
// Auth: internal only — the bearer must be the service-role key. Checked here
// explicitly, not just by the gateway, so a logged-in app user can't trigger a
// send for someone else's account.
//
// Idempotent: a row in public.welcome_emails is claimed (primary-key insert)
// BEFORE sending, so a double-fire can only ever send once. If the send fails,
// the claim is released so it can be re-sent by hand:
//   select public.fire_welcome_email('<user uuid>');
//
// Body: { userId }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildWelcomeEmail,
  fromWithName,
  sendEmail,
  SUPPORT_EMAIL,
} from "../_shared/email.ts";
import { logCloudEvent, logToCloud } from "../_shared/logToCloud.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[send-welcome-email]";
const SOURCE = "ef:send-welcome-email";
const FROM_NAME = "Zanbi Inspections";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
    }),
  );
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "server_misconfigured" }, 500);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt !== serviceKey) return json({ error: "unauthorized" }, 401);

  const admin: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId: string | null = null;
  try {
    const body = await req.json();
    userId = typeof body?.userId === "string" ? body.userId : null;
  } catch (_) {
    /* fall through */
  }
  if (!userId) return json({ error: "missing_user" }, 400);

  try {
    // 1. The auth record — the source of truth for the address and confirmation.
    const { data: authData, error: authErr } = await admin.auth.admin.getUserById(userId);
    if (authErr || !authData?.user) {
      logError("user_lookup_failed", authErr ?? new Error("not found"), { userId });
      return json({ ok: false, error: "user_not_found" }, 200);
    }
    const email = authData.user.email?.trim() ?? "";
    if (!email) {
      logInfo("skip_no_email", { userId });
      return json({ ok: true, skipped: "no_email" });
    }
    // Sent at signup, so most recipients haven't confirmed yet — deliberately,
    // since anyone stuck on verification needs the support contact most.
    const unverified = !authData.user.email_confirmed_at;

    // 2. Owners only — the copy is about starting a 30-day trial.
    const { data: profile } = await admin
      .from("users")
      .select("user_profile, org_sk")
      .eq("id", userId)
      .maybeSingle();
    if (profile?.user_profile !== "owner") {
      logInfo("skip_not_owner", { userId, profile: profile?.user_profile ?? null });
      return json({ ok: true, skipped: "not_owner" });
    }
    const orgSk = (profile?.org_sk as string | null) ?? null;

    // 3. Claim. The primary key makes this atomic: only one caller gets a row.
    const { data: claimed, error: claimErr } = await admin
      .from("welcome_emails")
      .insert({ user_id: userId })
      .select("user_id");
    if (claimErr) {
      // 23505 = unique violation = already welcomed (or being welcomed).
      if ((claimErr as { code?: string }).code === "23505") {
        logInfo("skip_already_sent", { userId });
        return json({ ok: true, skipped: "already_sent" });
      }
      logError("claim_failed", claimErr, { userId });
      return json({ ok: false, error: "db_error" }, 500);
    }
    if (!claimed || claimed.length === 0) {
      return json({ ok: true, skipped: "already_sent" });
    }

    // 4. Send. Replies go to support, since the email invites them to write in.
    const { subject, html, text } = buildWelcomeEmail({ unverified });
    const sent = await sendEmail({
      to: [email],
      subject,
      html,
      text,
      from: fromWithName(FROM_NAME),
      replyTo: SUPPORT_EMAIL,
    });

    if (!sent.ok) {
      // Release the claim so it can be re-sent by hand; never leave a user
      // marked "welcomed" when they weren't.
      await admin.from("welcome_emails").delete().eq("user_id", userId);
      logError("send_failed", new Error(sent.error), { userId });
      await logToCloud(admin, {
        level: "error",
        event: "welcome.failed",
        message: sent.error,
        context: `send-welcome-email user=${userId}`,
        userId,
        orgSk,
        source: SOURCE,
      });
      return json({ ok: false, error: "email_failed" }, 200);
    }

    await admin
      .from("welcome_emails")
      .update({ resend_id: sent.id ?? null })
      .eq("user_id", userId);

    logInfo("sent", { userId });
    void logCloudEvent(admin, SOURCE, "welcome.sent", { userId, orgSk });
    return json({ ok: true });
  } catch (e) {
    logError("unexpected", e, { userId });
    return json({ ok: false, error: "server_error" }, 500);
  }
});
