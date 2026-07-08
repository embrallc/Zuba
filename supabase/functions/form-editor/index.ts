// form-editor Edge Function.
//
// Serves the Form Builder web editor AND its persistence API from one origin
// (no CORS dance for the browser app), plus a token-minting endpoint for the
// mobile app.
//
// Routes (function base = /functions/v1/form-editor):
//   GET  ?t=<token>                 → 302 redirect to the static editor app
//                                      (Supabase rewrites text/html → text/plain
//                                      on the shared domain, so the SPA itself
//                                      lives on a static host; EDITOR_APP_URL
//                                      secret points at it)
//   GET  /api/template?t=           → { name, schema, draftUpdatedAt, publishedAt }
//   PUT  /api/template?t=           → save draft  { name, schema, baseUpdatedAt }
//                                      409 + current stamp on write conflict
//   POST /api/publish?t=            → copy draft → published
//   POST (root, Supabase JWT)       → { action: "mint" | "revoke" }  — owner only
//
// Security model: the editor link carries a 256-bit random token; we store
// only its SHA-256 hash. Minting revokes all prior tokens for the org, so
// "Regenerate" in the app is the kill switch for a leaked link. Tables are
// RLS-locked with no policies; only this function (service role) touches them.
//
// Deploy with: npx supabase functions deploy form-editor --no-verify-jwt
// (--no-verify-jwt is REQUIRED: the browser hits this with no Supabase JWT.
// The POST mint path verifies its own JWT in-code, like my-day-route.)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

declare const Deno: { env: { get(name: string): string | undefined } };

const TAG = "[form-editor]";
const TOKEN_TTL_DAYS = 90;
const MAX_SCHEMA_BYTES = 1_000_000;
const ASSETS_BUCKET = "form-assets";
// Editor downscales to ≤1200px before upload, so real payloads are ~100-400KB.
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Plain text on purpose: HTML doesn't render on the shared supabase.co
// domain, so a friendly sentence beats a wall of raw markup.
function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(`${TAG} ${event}`, JSON.stringify(fields));
}

function logError(
  event: string,
  err: unknown,
  fields: Record<string, unknown> = {},
) {
  const anyErr = err as Record<string, unknown> | null | undefined;
  // PostgREST errors carry the actionable detail in code/details/hint, NOT in
  // message — surface all of them so a swallowed write reveals its cause.
  console.error(
    `${TAG} ${event}`,
    JSON.stringify({
      ...fields,
      error:
        anyErr instanceof Error
          ? anyErr.message
          : (anyErr?.message ?? String(err)),
      code: anyErr?.code,
      details: anyErr?.details,
      hint: anyErr?.hint,
      status: anyErr?.status,
    }),
  );
}

const DENIED_TEXT =
  "This Form Builder link isn't valid anymore.\n\n" +
  "It may have expired or been regenerated. Open Zanbi on your phone and go to " +
  "Settings -> Form Builder to get a fresh link.";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

type TokenRow = { org_sk: string; user_id: string };

// deno-lint-ignore no-explicit-any
async function validateToken(admin: any, raw: string | null): Promise<TokenRow | null> {
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const { data, error } = await admin
    .from("form_editor_tokens")
    .select("org_sk, user_id, expires_at, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) {
    logError("token_lookup_failed", error);
    return null;
  }
  if (!data || data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return { org_sk: data.org_sk, user_id: data.user_id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      logError("missing_env", null);
      return json({ error: "server_misconfigured" }, 500);
    }
    const admin = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    // Path after the function slug: "" | "/api/template" | "/api/publish"
    const subPath = url.pathname.replace(/^.*?\/form-editor/, "") || "/";
    const rawToken = url.searchParams.get("t");
    logInfo("request", {
      method: req.method,
      subPath,
      hasToken: !!rawToken,
    });

    // ── Browser routes (token-authenticated) ────────────────────────────────
    if (subPath === "/api/asset") {
      const tok = await validateToken(admin, rawToken);
      if (!tok) return json({ error: "invalid_token" }, 401);

      // Upload: editor sends a pre-downscaled PNG/JPEG as base64. Magic bytes
      // are the contract — content-type claims are not trusted.
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        const b64 = body?.dataBase64;
        if (typeof b64 !== "string" || !b64) {
          return json({ error: "missing_data" }, 400);
        }
        let bytes: Uint8Array;
        try {
          const bin = atob(b64);
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } catch (_) {
          return json({ error: "bad_base64" }, 400);
        }
        if (bytes.length > MAX_ASSET_BYTES) {
          return json({ error: "too_large" }, 413);
        }
        const isPng =
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e;
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (!isPng && !isJpg) {
          return json({ error: "unsupported_format" }, 415);
        }
        const ext = isPng ? "png" : "jpg";
        const path = `${tok.org_sk}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await admin.storage
          .from(ASSETS_BUCKET)
          .upload(path, bytes, {
            contentType: isPng ? "image/png" : "image/jpeg",
          });
        if (upErr) {
          logError("asset_upload_failed", upErr, { org: tok.org_sk });
          return json({ error: "upload_failed" }, 500);
        }
        logInfo("asset_uploaded", { org: tok.org_sk, path, bytes: bytes.length });
        return json({ path });
      }

      // Read: 302 to a signed URL so a plain <img src> in the editor works.
      // Path must stay inside the caller's org folder.
      if (req.method === "GET") {
        const assetPath = url.searchParams.get("path") ?? "";
        if (!assetPath.startsWith(`${tok.org_sk}/`)) {
          return json({ error: "forbidden" }, 403);
        }
        const { data: signed, error: signErr } = await admin.storage
          .from(ASSETS_BUCKET)
          .createSignedUrl(assetPath, 60 * 60);
        if (signErr || !signed?.signedUrl) {
          return json({ error: "not_found" }, 404);
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: signed.signedUrl,
            "Cache-Control": "private, max-age=3000",
          },
        });
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    if (subPath === "/api/template" || subPath === "/api/publish") {
      const tok = await validateToken(admin, rawToken);
      if (!tok) return json({ error: "invalid_token" }, 401);

      if (subPath === "/api/template" && req.method === "GET") {
        const { data, error } = await admin
          .from("form_templates")
          .select("name, draft_schema, draft_updated_at, published_at")
          .eq("org_sk", tok.org_sk)
          .maybeSingle();
        if (error) {
          logError("template_read_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        return json({
          name: data?.name ?? null,
          schema: data?.draft_schema ?? null,
          draftUpdatedAt: data?.draft_updated_at ?? null,
          publishedAt: data?.published_at ?? null,
        });
      }

      if (subPath === "/api/template" && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        const schema = body?.schema;
        if (!schema || typeof schema !== "object") {
          return json({ error: "missing_schema" }, 400);
        }
        if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
          return json({ error: "schema_too_large" }, 413);
        }

        const { data: existing } = await admin
          .from("form_templates")
          .select("draft_updated_at")
          .eq("org_sk", tok.org_sk)
          .maybeSingle();

        // Optimistic concurrency: a second tab/device saving over a newer
        // draft gets a 409 instead of silently clobbering it. Compare as
        // instants, NOT strings — we write JS-format stamps ("...Z") but
        // Postgres serializes timestamptz back as "...+00:00", so string
        // equality false-positives a conflict on every second save.
        const existingMs = existing?.draft_updated_at
          ? new Date(existing.draft_updated_at).getTime()
          : NaN;
        const baseMs = body?.baseUpdatedAt
          ? new Date(body.baseUpdatedAt).getTime()
          : NaN;
        if (
          Number.isFinite(existingMs) &&
          Number.isFinite(baseMs) &&
          existingMs !== baseMs
        ) {
          return json(
            { error: "conflict", draftUpdatedAt: existing.draft_updated_at },
            409,
          );
        }

        const nowIso = new Date().toISOString();
        const { data: saved, error } = await admin
          .from("form_templates")
          .upsert(
            {
              org_sk: tok.org_sk,
              name:
                typeof body?.name === "string" && body.name.trim()
                  ? body.name.trim().slice(0, 120)
                  : "Inspection Report",
              draft_schema: schema,
              draft_updated_at: nowIso,
              updated_by: tok.user_id,
            },
            { onConflict: "org_sk" },
          )
          .select("org_sk, draft_updated_at");
        if (error) {
          logError("template_save_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        logInfo("template_save.result", {
          org: tok.org_sk,
          rowsWritten: Array.isArray(saved) ? saved.length : 0,
          savedOrg: saved?.[0]?.org_sk ?? null,
        });
        return json({ draftUpdatedAt: nowIso });
      }

      if (subPath === "/api/publish" && req.method === "POST") {
        logInfo("publish.begin", { org: tok.org_sk, user: tok.user_id });
        const { data: row, error: readErr } = await admin
          .from("form_templates")
          .select("draft_schema")
          .eq("org_sk", tok.org_sk)
          .maybeSingle();
        if (readErr) {
          logError("publish.read_failed", readErr, { org: tok.org_sk });
        }
        logInfo("publish.read", {
          org: tok.org_sk,
          rowExists: !!row,
          hasDraft: !!row?.draft_schema,
        });
        if (readErr || !row?.draft_schema) {
          logInfo("publish.exit", {
            org: tok.org_sk,
            why: "nothing_to_publish",
            reason: readErr ? "read_error" : "no_draft_schema",
          });
          return json({ error: "nothing_to_publish" }, 400);
        }
        const nowIso = new Date().toISOString();
        const { data: pub, error } = await admin
          .from("form_templates")
          .update({ published_schema: row.draft_schema, published_at: nowIso })
          .eq("org_sk", tok.org_sk)
          .select("org_sk, published_at");
        if (error) {
          logError("publish_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        logInfo("published", {
          org: tok.org_sk,
          rowsWritten: Array.isArray(pub) ? pub.length : 0,
          savedOrg: pub?.[0]?.org_sk ?? null,
        });
        return json({ publishedAt: nowIso });
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    // ── Walkthrough (data-capture) template — same org, separate document ───
    if (
      subPath === "/api/walkthrough" ||
      subPath === "/api/walkthrough/publish"
    ) {
      const tok = await validateToken(admin, rawToken);
      if (!tok) return json({ error: "invalid_token" }, 401);

      if (subPath === "/api/walkthrough" && req.method === "GET") {
        const { data, error } = await admin
          .from("walkthrough_templates")
          .select(
            "name, draft_schema, draft_updated_at, published_at, published_version",
          )
          .eq("org_sk", tok.org_sk)
          .maybeSingle();
        if (error) {
          logError("walkthrough_read_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        return json({
          name: data?.name ?? null,
          schema: data?.draft_schema ?? null,
          draftUpdatedAt: data?.draft_updated_at ?? null,
          publishedAt: data?.published_at ?? null,
          publishedVersion: data?.published_version ?? 0,
        });
      }

      if (subPath === "/api/walkthrough" && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        const schema = body?.schema;
        const schemaBytes = schema ? JSON.stringify(schema).length : 0;
        logInfo("walkthrough_save.begin", {
          org: tok.org_sk,
          user: tok.user_id,
          hasSchema: !!schema && typeof schema === "object",
          schemaBytes,
          sections: Array.isArray(schema?.sections)
            ? schema.sections.length
            : null,
          baseUpdatedAt: body?.baseUpdatedAt ?? null,
        });
        if (!schema || typeof schema !== "object") {
          logInfo("walkthrough_save.exit", { org: tok.org_sk, why: "missing_schema" });
          return json({ error: "missing_schema" }, 400);
        }
        if (schemaBytes > MAX_SCHEMA_BYTES) {
          logInfo("walkthrough_save.exit", {
            org: tok.org_sk,
            why: "schema_too_large",
            schemaBytes,
          });
          return json({ error: "schema_too_large" }, 413);
        }

        const { data: existing, error: existErr } = await admin
          .from("walkthrough_templates")
          .select("draft_updated_at")
          .eq("org_sk", tok.org_sk)
          .maybeSingle();
        if (existErr) {
          logError("walkthrough_save.existing_read_failed", existErr, {
            org: tok.org_sk,
          });
        }

        // Optimistic concurrency — compare as instants, not strings (Postgres
        // serializes "+00:00", we write "...Z").
        const existingMs = existing?.draft_updated_at
          ? new Date(existing.draft_updated_at).getTime()
          : NaN;
        const baseMs = body?.baseUpdatedAt
          ? new Date(body.baseUpdatedAt).getTime()
          : NaN;
        logInfo("walkthrough_save.concurrency", {
          org: tok.org_sk,
          rowExists: !!existing,
          existingStamp: existing?.draft_updated_at ?? null,
          existingMs: Number.isFinite(existingMs) ? existingMs : null,
          baseMs: Number.isFinite(baseMs) ? baseMs : null,
        });
        if (
          Number.isFinite(existingMs) &&
          Number.isFinite(baseMs) &&
          existingMs !== baseMs
        ) {
          logInfo("walkthrough_save.exit", { org: tok.org_sk, why: "conflict" });
          return json(
            { error: "conflict", draftUpdatedAt: existing.draft_updated_at },
            409,
          );
        }

        const nowIso = new Date().toISOString();
        // .select() so we can see the ACTUAL persisted rows — a service-role
        // upsert that writes 0 rows (or a filtered/denied write) is the whole
        // mystery, so capture and log the row count + echo.
        const { data: saved, error } = await admin
          .from("walkthrough_templates")
          .upsert(
            {
              org_sk: tok.org_sk,
              name:
                typeof body?.name === "string" && body.name.trim()
                  ? body.name.trim().slice(0, 120)
                  : "Walkthrough",
              draft_schema: schema,
              draft_updated_at: nowIso,
              updated_by: tok.user_id,
            },
            { onConflict: "org_sk" },
          )
          .select("org_sk, draft_updated_at, updated_by");
        if (error) {
          logError("walkthrough_save_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        logInfo("walkthrough_save.result", {
          org: tok.org_sk,
          rowsWritten: Array.isArray(saved) ? saved.length : 0,
          savedOrg: saved?.[0]?.org_sk ?? null,
          savedStamp: saved?.[0]?.draft_updated_at ?? null,
        });
        return json({ draftUpdatedAt: nowIso });
      }

      if (subPath === "/api/walkthrough/publish" && req.method === "POST") {
        logInfo("walkthrough_publish.begin", {
          org: tok.org_sk,
          user: tok.user_id,
        });
        const { data: row, error: readErr } = await admin
          .from("walkthrough_templates")
          .select("draft_schema, published_version")
          .eq("org_sk", tok.org_sk)
          .maybeSingle();
        if (readErr) {
          logError("walkthrough_publish.read_failed", readErr, {
            org: tok.org_sk,
          });
        }
        logInfo("walkthrough_publish.read", {
          org: tok.org_sk,
          rowExists: !!row,
          hasDraft: !!row?.draft_schema,
          publishedVersion: row?.published_version ?? null,
        });
        if (readErr || !row?.draft_schema) {
          // Formerly a SILENT exit — this is the most likely place the publish
          // "runs but nothing persists" if the draft save never landed.
          logInfo("walkthrough_publish.exit", {
            org: tok.org_sk,
            why: "nothing_to_publish",
            reason: readErr ? "read_error" : "no_draft_schema",
          });
          return json({ error: "nothing_to_publish" }, 400);
        }
        const nowIso = new Date().toISOString();
        const nextVersion = (row.published_version ?? 0) + 1;
        const { data: pub, error } = await admin
          .from("walkthrough_templates")
          .update({
            published_schema: row.draft_schema,
            published_at: nowIso,
            published_version: nextVersion,
          })
          .eq("org_sk", tok.org_sk)
          .select("org_sk, published_version, published_at");
        if (error) {
          logError("walkthrough_publish_failed", error, { org: tok.org_sk });
          return json({ error: "db_error" }, 500);
        }
        logInfo("walkthrough_published", {
          org: tok.org_sk,
          version: nextVersion,
          rowsWritten: Array.isArray(pub) ? pub.length : 0,
          savedOrg: pub?.[0]?.org_sk ?? null,
          savedVersion: pub?.[0]?.published_version ?? null,
        });
        return json({ publishedAt: nowIso, publishedVersion: nextVersion });
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    // ── App route: mint / revoke editor links (Supabase JWT, owner only) ───
    if (req.method === "POST") {
      const authHeader = req.headers.get("Authorization") ?? "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      if (!jwt) return json({ error: "missing_token" }, 401);

      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await anonClient.auth.getUser();
      if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
      const userId = userData.user.id;

      const { data: profile, error: profErr } = await admin
        .from("users")
        .select("org_sk, user_profile")
        .eq("id", userId)
        .maybeSingle();
      if (profErr || !profile?.org_sk) return json({ error: "no_profile" }, 403);
      if (profile.user_profile !== "owner") {
        return json({ error: "owner_only" }, 403);
      }

      const body = await req.json().catch(() => ({}));
      const action = body?.action ?? "mint";

      // Either action starts by revoking every active link for the org.
      const { error: revokeErr } = await admin
        .from("form_editor_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("org_sk", profile.org_sk)
        .is("revoked_at", null);
      if (revokeErr) {
        logError("revoke_failed", revokeErr, { org: profile.org_sk });
        return json({ error: "db_error" }, 500);
      }
      if (action === "revoke") {
        logInfo("tokens_revoked", { org: profile.org_sk, userId });
        return json({ revoked: true });
      }

      const token = randomToken();
      const expiresAt = new Date(
        Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { error: insertErr } = await admin.from("form_editor_tokens").insert({
        org_sk: profile.org_sk,
        user_id: userId,
        token_hash: await sha256Hex(token),
        expires_at: expiresAt,
      });
      if (insertErr) {
        logError("token_insert_failed", insertErr, { org: profile.org_sk });
        return json({ error: "db_error" }, 500);
      }
      logInfo("token_minted", { org: profile.org_sk, userId });
      return json({
        url: `${supabaseUrl}/functions/v1/form-editor?t=${token}`,
        expiresAt,
      });
    }

    // ── Browser route: bounce valid links to the static editor app ─────────
    // The function URL is the canonical link we hand out (it never changes);
    // the static host behind it can move freely via the EDITOR_APP_URL secret.
    if (req.method === "GET") {
      const tok = await validateToken(admin, rawToken);
      if (!tok) {
        logInfo("editor_denied", { hasToken: !!rawToken });
        return textResponse(DENIED_TEXT, 401);
      }
      const appUrl = Deno.env.get("EDITOR_APP_URL");
      if (!appUrl) {
        logError("missing_editor_app_url", null);
        return textResponse(
          "The Form Builder isn't fully set up yet (missing EDITOR_APP_URL). " +
            "Set the secret and try again.",
          503,
        );
      }
      logInfo("editor_redirect", { org: tok.org_sk });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${appUrl.replace(/\/$/, "")}/?t=${encodeURIComponent(rawToken!)}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    logError("unhandled", e);
    return json({ error: "internal" }, 500);
  }
});
