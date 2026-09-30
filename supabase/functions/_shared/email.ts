// Resend email wrapper. RESEND_API_KEY is a Supabase secret; the sending
// domain must be DNS-verified in Resend. The from address is configurable via
// REPORT_FROM_EMAIL (falls back to a reports@ address on the verified domain).

declare const Deno: { env: { get(name: string): string | undefined } };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function defaultFrom(): string {
  // Must be on the DNS-verified Resend domain (notifyinspection.embrallc.com).
  return (
    Deno.env.get("REPORT_FROM_EMAIL") ||
    "Zanbi <reports@notifyinspection.embrallc.com>"
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

// Invoice email body — the Stripe payment link delivered to the client. Shared
// by the auto-send path (stripe-create-checkout's autoEmailInvoice) and the
// manual "Email invoice" path (resend-invoice) so both stay byte-identical.
export function buildInvoiceEmail(opts: {
  fullName?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  checkoutUrl: string;
}): { subject: string; html: string; text: string } {
  const who = opts.fullName || "there";
  const addr = [opts.addressLine1, opts.city, opts.state]
    .filter(Boolean)
    .join(", ");
  const subject = `Your invoice${addr ? ` — ${addr}` : ""}`;
  const text =
    `Hi ${who},\n\nYour inspector has sent you an invoice. View the amount and ` +
    `pay securely here:\n${opts.checkoutUrl}\n\nThank you!`;
  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5">` +
    `<p>Hi ${who},</p>` +
    `<p>Your inspector has sent you an invoice${addr ? ` for <strong>${addr}</strong>` : ""}.</p>` +
    `<p><a href="${opts.checkoutUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">View &amp; pay invoice</a></p>` +
    `<p style="color:#888;font-size:13px">Or paste this link into your browser:<br>${opts.checkoutUrl}</p>` +
    `</div>`;
  return { subject, html, text };
}

// One-time passcode email for the hosted client report viewer (email-2FA). The
// recipient enters this code on the report page to unlock the interactive report.
// The code also appears in the subject so it's glanceable from a notification.
export function buildOtpEmail(opts: {
  code: string;
  propertyLabel?: string | null;
  ttlMinutes?: number;
}): { subject: string; html: string; text: string } {
  const addr = (opts.propertyLabel || "").trim();
  const ttl = opts.ttlMinutes ?? 10;
  const subject = `Your report access code: ${opts.code}`;
  const text =
    `Your Zanbi inspection report access code is ${opts.code}.\n\n` +
    `Enter it on the report page to view your report${addr ? ` for ${addr}` : ""}. ` +
    `This code expires in ${ttl} minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c2e;line-height:1.5;max-width:460px">` +
    `<p>Here is your access code to view your inspection report${
      addr ? ` for <strong>${addr}</strong>` : ""
    }:</p>` +
    `<p style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f6f6fb;` +
    `border:1px solid #e4e4ee;border-radius:12px;padding:16px 0;text-align:center;` +
    `color:#1c1c2e;margin:18px 0">${opts.code}</p>` +
    `<p style="color:#5b5b6b;font-size:14px">Enter this code on the report page. ` +
    `It expires in ${ttl} minutes.</p>` +
    `<p style="color:#888;font-size:13px">If you didn't request this, you can safely ` +
    `ignore this email.</p>` +
    `</div>`;
  return { subject, html, text };
}

// The report-ready email delivered to the client. Adapts to which artifacts the
// inspection produced (Report Types): a PDF link, the interactive online link, or
// both. At least one URL must be present (the caller sends buildCompleteNotice-
// Email instead when neither type is enabled). Shared by the auto-send path
// (send-report-to-client) and the manual send (resend-report) so the two emails
// stay byte-identical.
export function buildReportEmail(opts: {
  fullName?: string | null;
  addr?: string | null;
  pdfUrl?: string | null;
  onlineUrl?: string | null;
  ttlDays?: number;
}): { subject: string; html: string; text: string } {
  const who = opts.fullName || "there";
  const addr = (opts.addr || "").trim();
  const ttl = opts.ttlDays ?? 30;
  const pdfUrl = opts.pdfUrl || null;
  const onlineUrl = opts.onlineUrl || null;

  const subject = `Your inspection report${addr ? ` — ${addr}` : ""}`;

  const text =
    `Hi ${who},\n\n` +
    `Your inspection report${addr ? ` for ${addr}` : ""} is ready.\n\n` +
    (pdfUrl ? `View and download the PDF here:\n${pdfUrl}\n\n` : "") +
    (onlineUrl
      ? `${pdfUrl ? "Prefer an interactive version? " : ""}View your report online` +
        ` — you'll confirm your email with a quick code for privacy:\n${onlineUrl}\n\n`
      : "") +
    (pdfUrl ? `The download link will stop working after ${ttl} days. ` : "") +
    `Thank you!`;

  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5">` +
    `<p>Hi ${who},</p>` +
    `<p>Your inspection report${addr ? ` for <strong>${addr}</strong>` : ""} is ready.</p>` +
    (pdfUrl
      ? `<p><a href="${pdfUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">View report (PDF)</a></p>`
      : "") +
    (onlineUrl
      ? `<p><a href="${onlineUrl}" style="display:inline-block;background:#5b5bd6;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">View report online</a></p>` +
        `<p style="color:#888;font-size:13px">The online report is interactive and mobile-friendly. ` +
        `For your privacy, you'll confirm your email with a quick code.</p>`
      : "") +
    (pdfUrl
      ? `<p style="color:#888;font-size:13px">Or paste the PDF link into your browser:<br>${pdfUrl}</p>` +
        `<p style="color:#888;font-size:13px">The download link expires in ${ttl} days.</p>`
      : "") +
    `</div>`;

  return { subject, html, text };
}

// Sent when an inspection is completed but the client gets NO report (both report
// types are turned off for it) — a short courtesy note so the client still hears
// that the visit wrapped up.
export function buildCompleteNoticeEmail(opts: {
  fullName?: string | null;
  addr?: string | null;
}): { subject: string; html: string; text: string } {
  const who = opts.fullName || "there";
  const addr = (opts.addr || "").trim();
  const subject = `Your inspection is complete${addr ? ` — ${addr}` : ""}`;
  const text =
    `Hi ${who},\n\n` +
    `Your inspection${addr ? ` at ${addr}` : ""} is complete. ` +
    `If you have any questions, just reply to this email. Thank you!`;
  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5">` +
    `<p>Hi ${who},</p>` +
    `<p>Your inspection${addr ? ` at <strong>${addr}</strong>` : ""} is complete.</p>` +
    `<p>If you have any questions, just reply to this email. Thank you!</p>` +
    `</div>`;
  return { subject, html, text };
}

// Keep whatever verified address REPORT_FROM_EMAIL holds, but show a specific
// display name — e.g. "Zanbi Inspections <reports@…>" for the welcome email.
export function fromWithName(name: string): string {
  const base = defaultFrom();
  const addr = base.match(/<([^>]+)>/)?.[1] ?? base.trim();
  return `${name} <${addr}>`;
}

// One-time welcome for a new owner, sent at signup.
export const SUPPORT_EMAIL = "support@embrallc.com";

// `unverified`: the user hasn't confirmed their email yet (the normal case at
// signup). They can't log in to reach Settings, so they get one extra paragraph
// pointing at the confirmation email and at support if it isn't working.
export function buildWelcomeEmail(
  opts: { unverified?: boolean } = {},
): { subject: string; html: string; text: string } {
  const subject = "Welcome to Property Inspection Reporting by Zanbi";
  const verifyText = opts.unverified
    ? `Before you sign in, please confirm your email using the confirmation email we just sent ` +
      `(check your spam or junk folder if you don't see it). If it didn't arrive or you have trouble ` +
      `confirming, email us at ${SUPPORT_EMAIL} and we'll get you in.\n\n`
    : "";
  const verifyHtml = opts.unverified
    ? `<p style="background:#F3F4FF;border-radius:10px;padding:12px 14px">Before you sign in, please ` +
      `confirm your email using the confirmation email we just sent (check your spam or junk folder ` +
      `if you don't see it). If it didn't arrive or you have trouble confirming, email us at ` +
      `<a href="mailto:${SUPPORT_EMAIL}" style="color:#5C5CE8">${SUPPORT_EMAIL}</a> and we'll get you in.</p>`
    : "";
  const text =
    `Welcome!\n\n` +
    `We are excited you are giving Property Inspection Reporting by Zanbi a try for 30 days.\n\n` +
    verifyText +
    `If you need any assistance with setup or settings configuration, or have any new ideas you ` +
    `think would help us get better, please put your request for help or comment in Settings ` +
    `(top right hamburger menu) → Ideas, Feedback, & Issues (bottom of the settings options).\n\n` +
    `Someone will be happy to get back with you if you need any assistance getting to know the ` +
    `app. The settings options are designed to tell you what they do right up front, but don't ` +
    `hesitate to reach out for more help. You can also email us at ${SUPPORT_EMAIL} with any ` +
    `questions.\n\n` +
    `Thank you for giving us a try!`;
  const html =
    `<div style="font-family:-apple-system,system-ui,Segoe UI,sans-serif;color:#1c1c1e;line-height:1.5;max-width:560px">` +
    `<p style="font-size:18px;font-weight:600;margin:0 0 12px">Welcome!</p>` +
    `<p>We are excited you are giving <strong>Property Inspection Reporting by Zanbi</strong> a try for 30 days.</p>` +
    verifyHtml +
    `<p>If you need any assistance with setup or settings configuration, or have any new ideas you ` +
    `think would help us get better, please put your request for help or comment in ` +
    `<strong>Settings</strong> (top right hamburger menu) → <strong>Ideas, Feedback, &amp; Issues</strong> ` +
    `(bottom of the settings options).</p>` +
    `<p>Someone will be happy to get back with you if you need any assistance getting to know the ` +
    `app. The settings options are designed to tell you what they do right up front, but don't ` +
    `hesitate to reach out for more help. You can also email us at ` +
    `<a href="mailto:${SUPPORT_EMAIL}" style="color:#5C5CE8">${SUPPORT_EMAIL}</a> with any questions.</p>` +
    `<p>Thank you for giving us a try!</p>` +
    `</div>`;
  return { subject, html, text };
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
