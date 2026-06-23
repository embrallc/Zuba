// ai-rewrite Edge Function.
//
// Turns an inspector's brief shorthand note ("broken shingle, cracked main
// stack chimney") into clear, professional, report-ready prose using Gemini.
// It is a DRAFTING aid only — the client always shows the suggestion for the
// inspector to review/edit/accept; this function never writes to a record.
//
// Flow:
//   1. Verify JWT → user_id
//   2. Validate input
//   3. Cache lookup (skip on regenerate): identical (text+context+tone) →
//      return the prior rewrite, no Gemini call, no quota spend
//   4. Daily per-user soft cap (counts only real Gemini calls) → 429 if over
//   5. Call Gemini Flash with a hallucination-constrained prompt
//   6. Cache the result (non-regenerate), bump the daily counter, return
//
// Cost note: each Gemini call is ~$0.0001, so the cap + cache exist to bound
// runaway/abuse and keep repeats free — NOT to ration legitimate use.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };
declare const crypto: {
  subtle: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> };
};

const TAG = "[ai-rewrite]";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Generous soft cap — a real inspector won't approach it; it only bounds a
// runaway loop or a replayed token. Counts ONLY actual Gemini calls.
const DAILY_CAP = 300;
const MAX_INPUT_CHARS = 2000;

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
      error: anyErr instanceof Error ? anyErr.message : (anyErr?.message ?? String(err)),
      status: anyErr?.status,
    }),
  );
}

type ContextItem = { label?: string; value?: string };
type ReqBody = {
  text?: string;
  fieldLabel?: string;
  sectionTitle?: string;
  context?: ContextItem[];
  tone?: string;
  regenerate?: boolean;
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatContext(context: ContextItem[] | undefined): string {
  if (!Array.isArray(context) || context.length === 0) return "none";
  return context
    .filter((c) => c && c.value)
    .map((c) => `${c.label ?? "Field"}: ${c.value}`)
    .join("; ");
}

// Ask Gemini to phrase the note professionally. Returns the rewrite string, or
// null on any failure (missing key, timeout, malformed). The prompt forbids
// inventing findings — an inspection report is a quasi-legal document.
async function callGemini(
  apiKey: string,
  body: ReqBody,
  regenerate: boolean,
): Promise<string | null> {
  const tone = body.tone || "professional";
  const systemPrompt =
    `You are assisting a professional home inspector. Rewrite the inspector's ` +
    `brief, shorthand field note into clear, objective, ${tone} prose suitable ` +
    `for a client-facing inspection report.\n\n` +
    `RULES\n` +
    `- The note may be terse (a few words). Expand it into complete, professional sentence(s).\n` +
    `- Describe ONLY what the note and provided context indicate. Never invent defects, ` +
    `causes, severity, measurements, locations, or recommendations that are not supported.\n` +
    `- Preserve any specific measurements, locations, materials, and quantities exactly as given.\n` +
    `- Neutral, professional tone — factual, not alarmist or casual.\n` +
    `- Usually 1–3 sentences. If the note already reads well, make only light edits.\n` +
    `- Return ONLY the rewritten description text — no labels, quotes, markdown, or preamble.`;

  const userText =
    `Section: ${body.sectionTitle || "—"}\n` +
    `Field: ${body.fieldLabel || "—"}\n` +
    `Related findings: ${formatContext(body.context)}\n` +
    `Inspector's note: ${body.text}`;

  const reqBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      // Gemini's responseSchema uses the proto Type enum — values MUST be
      // uppercase or it 400s (and we'd silently fail).
      responseSchema: {
        type: "OBJECT",
        properties: { rewrite: { type: "STRING" } },
        required: ["rewrite"],
      },
      // A touch more variety on an explicit "regenerate", steadier otherwise.
      temperature: regenerate ? 0.85 : 0.45,
      maxOutputTokens: 512,
      // 2.5-flash thinks by default; for a short rewrite that just burns
      // latency/tokens and can starve the output. Disable it.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      logError("gemini_http_error", null, { status: res.status, text });
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    const rewrite = typeof parsed?.rewrite === "string" ? parsed.rewrite.trim() : "";
    return rewrite || null;
  } catch (e) {
    logError("gemini_failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // 1. JWT verify
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "missing_token" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      logError("missing_supabase_env", null);
      return json({ error: "server_misconfigured" }, 500);
    }
    if (!geminiKey) {
      logError("missing_gemini_key", null);
      return json({ error: "server_misconfigured" }, 500);
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    const userId = userData.user.id;

    // 2. Validate input
    const body: ReqBody = (await req.json().catch(() => ({}))) as ReqBody;
    const text = (body.text ?? "").trim();
    if (!text) return json({ error: "empty_input" }, 400);
    if (text.length > MAX_INPUT_CHARS) {
      return json({ error: "input_too_long" }, 400);
    }
    const regenerate = !!body.regenerate;
    const tone = body.tone || "professional";

    const admin = createClient(supabaseUrl, serviceKey);

    // 3. Cache lookup (identical input → prior rewrite; free, no quota spend).
    const cacheKey = `airewrite:${await sha256Hex(
      `${text} ${formatContext(body.context)} ${tone}`,
    )}`;
    if (!regenerate) {
      const { data: cached } = await admin
        .from("api_cache")
        .select("value")
        .eq("user_id", userId)
        .eq("cache_key", cacheKey)
        .maybeSingle();
      const cachedRewrite = (cached?.value as { rewrite?: string } | null)?.rewrite;
      if (typeof cachedRewrite === "string" && cachedRewrite) {
        logInfo("cache_hit", { userId });
        return json({ rewrite: cachedRewrite, cached: true });
      }
    }

    // 4. Daily per-user soft cap (counts real Gemini calls only).
    const today = new Date().toISOString().slice(0, 10);
    const countKey = `airewrite:count:${today}`;
    const { data: countRow } = await admin
      .from("api_cache")
      .select("value")
      .eq("user_id", userId)
      .eq("cache_key", countKey)
      .maybeSingle();
    const usedToday = Number((countRow?.value as { n?: number } | null)?.n ?? 0);
    if (usedToday >= DAILY_CAP) {
      logInfo("rate_limited", { userId, usedToday });
      return json({ error: "rate_limited" }, 429);
    }

    // 5. Gemini — the one billable call. Each line is one outbound Gemini
    // request; filter logs by this string to monitor spend.
    logInfo("gemini_call", { userId, regenerate, chars: text.length });
    const rewrite = await callGemini(geminiKey, { ...body, text, tone }, regenerate);
    if (!rewrite) return json({ error: "ai_failed" }, 502);

    // 6. Persist cache (stable first result only) + bump the daily counter.
    const nowIso = new Date().toISOString();
    if (!regenerate) {
      await admin.from("api_cache").upsert(
        {
          user_id: userId,
          cache_key: cacheKey,
          value: { rewrite },
          api_source: "gemini",
          expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        },
        { onConflict: "user_id,cache_key" },
      );
    }
    await admin.from("api_cache").upsert(
      {
        user_id: userId,
        cache_key: countKey,
        value: { n: usedToday + 1 },
        api_source: "gemini",
        // Keep counter rows a couple days then let them expire.
        expires_at: new Date(Date.now() + 2 * CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "user_id,cache_key" },
    );

    logInfo("rewrite_ok", { userId, usedToday: usedToday + 1, at: nowIso });
    return json({ rewrite, cached: false });
  } catch (e) {
    logError("unhandled", e);
    return json({ error: "internal" }, 500);
  }
});
