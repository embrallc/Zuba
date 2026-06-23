// Resend email wrapper. RESEND_API_KEY is a Supabase secret; the sending
// domain must be DNS-verified in Resend. The from address is configurable via
// REPORT_FROM_EMAIL (falls back to a reports@ address on the verified domain).

declare const Deno: { env: { get(name: string): string | undefined } };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function defaultFrom(): string {
  // Must be on the DNS-verified Resend domain (notifyinspection.embrallc.com).
  return (
    Deno.env.get("REPORT_FROM_EMAIL") ||
    "Zuba <reports@notifyinspection.embrallc.com>"
  );
}

// Light sanity filter so a malformed recipient can't fail the whole send.
export function validEmails(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const s = typeof e === "string" ? e.trim().toLowerCase() : "";
    if (s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Resolve which addresses receive a given channel from an inspection's
// report_recipients, tolerating both formats:
//   - NEW object form: { report: string[], invoice: string[] } — per-channel
//     subscriptions chosen in the app.
//   - LEGACY array form: [{ email, label }] | [] — everyone got the report and
//     only the payer (primary email) got the invoice.
export function channelRecipients(
  reportRecipients: unknown,
  primaryEmail: string | null | undefined,
  channel: "report" | "invoice",
): string[] {
  if (
    reportRecipients &&
    typeof reportRecipients === "object" &&
    !Array.isArray(reportRecipients)
  ) {
    const list = (reportRecipients as Record<string, unknown>)[channel];
    return validEmails(Array.isArray(list) ? list : []);
  }
  // Legacy fallback.
  const legacy = Array.isArray(reportRecipients)
    ? (reportRecipients as Array<{ email?: string } | string>).map((r) =>
        typeof r === "string" ? r : r?.email,
      )
    : [];
  if (channel === "report") return validEmails([...legacy, primaryEmail]);
  return validEmails([primaryEmail]);
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  from,
  replyTo,
}: {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  const recipients = (to ?? []).filter(Boolean);
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from || defaultFrom(),
        to: recipients,
        subject,
        html,
        text,
        reply_to: replyTo,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `resend ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
