// Template persistence. Two drivers:
//   - real: token from ?t=, same-origin API on the form-editor edge function
//   - mock: no token (local `vite dev`) → localStorage, so the editor is
//     fully usable standalone before any backend exists
const params = new URLSearchParams(location.search);
const token = params.get("t");
export const hasToken = !!token;

// The editor is statically hosted (Cloudflare Pages) because Supabase rewrites
// text/html to text/plain on its shared domain — so API calls go cross-origin
// to the edge function, which already answers CORS.
//
// VITE_API_BASE is environment-specific (staging vs prod form-editor function)
// and is baked in at build time from the per-mode env file (.env.production /
// .env.staging). It is only used when a token is present; local `vite dev` runs
// in mock mode (no token) and never reaches the network.
const base = import.meta.env.VITE_API_BASE ?? "";
const LOCAL_KEY = "kensa-form-template";
const LOCAL_WALK_KEY = "kensa-walkthrough-template";

// Server's draft_updated_at echo — optimistic-concurrency baseline so two
// open tabs can't silently clobber each other. Tracked per designer.
let lastUpdatedAt = null;
let lastWalkUpdatedAt = null;

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}?t=${encodeURIComponent(token)}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const err = new Error("conflict");
    err.conflict = true;
    err.serverUpdatedAt = body?.draftUpdatedAt;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function loadTemplate() {
  if (!hasToken) {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { name: null, schema: null };
  }
  const data = await request("/api/template");
  lastUpdatedAt = data?.draftUpdatedAt ?? null;
  return data;
}

export async function saveTemplate({ name, schema }) {
  if (!hasToken) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ name, schema }));
    return { local: true };
  }
  const data = await request("/api/template", {
    method: "PUT",
    body: JSON.stringify({ name, schema, baseUpdatedAt: lastUpdatedAt }),
  });
  lastUpdatedAt = data?.draftUpdatedAt ?? lastUpdatedAt;
  return data;
}

export async function publishTemplate() {
  if (!hasToken) return { local: true };
  return request("/api/publish", { method: "POST" });
}

// ── Walkthrough (data-capture) template — same org, separate document ────────

export async function loadWalkthrough() {
  if (!hasToken) {
    try {
      const raw = localStorage.getItem(LOCAL_WALK_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { name: null, schema: null };
  }
  const data = await request("/api/walkthrough");
  lastWalkUpdatedAt = data?.draftUpdatedAt ?? null;
  return data;
}

export async function saveWalkthrough({ name, schema }) {
  if (!hasToken) {
    localStorage.setItem(LOCAL_WALK_KEY, JSON.stringify({ name, schema }));
    return { local: true };
  }
  const data = await request("/api/walkthrough", {
    method: "PUT",
    body: JSON.stringify({ name, schema, baseUpdatedAt: lastWalkUpdatedAt }),
  });
  lastWalkUpdatedAt = data?.draftUpdatedAt ?? lastWalkUpdatedAt;
  return data;
}

export async function publishWalkthrough() {
  if (!hasToken) return { local: true };
  return request("/api/walkthrough/publish", { method: "POST" });
}

// Upload a processed (downscaled) PNG/JPEG for an image element. In local
// mock mode the data URL itself becomes the "path" so previews still work.
export async function uploadAsset({ dataBase64, contentType }) {
  if (!hasToken) {
    return { path: `data:${contentType};base64,${dataBase64}` };
  }
  return request("/api/asset", {
    method: "POST",
    body: JSON.stringify({ dataBase64, contentType }),
  });
}

// Renderable URL for an asset path (the function 302s to a signed URL).
export function assetUrl(path) {
  if (!path) return null;
  if (path.startsWith("data:")) return path;
  if (!hasToken) return null;
  return `${base}/api/asset?t=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
}
