// Shared Google Drive/OAuth client for the Drive Backup feature.
//
// Everything the drive-* functions need to talk to Google, in one place: the
// OAuth code flow (PKCE), refresh-token → access-token minting, and the small
// slice of the Drive v3 API we use (create/rename/move folders, upload files,
// overwrite file contents, trash a file).
//
// SCOPE: `drive.file` ONLY — per-file access to files this app created. It is a
// NON-SENSITIVE scope (no Google security assessment / annual re-verification),
// and it physically cannot read the inspector's other Drive files. That is the
// whole security story of this feature; do not widen it.
//
// The OAuth client_secret lives only in this server-side env — it is never sent
// to the device and never committed.

declare const Deno: { env: { get(name: string): string | undefined } };

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// How a failure should be treated by the caller. The runner uses this to decide
// between "stop and ask the owner to reconnect", "stop and tell them Drive is
// full", "skip this one file", and "back off and retry".
export type DriveErrorKind =
  | "auth" // refresh token dead — owner must reconnect
  | "quota" // their Drive is full — retrying can't help
  | "not_found" // the file/folder we remembered is gone — recreate it
  | "rate" // rate limited — back off
  | "transient" // 5xx / network — back off
  | "permanent"; // 4xx we can't fix by retrying

export class DriveError extends Error {
  kind: DriveErrorKind;
  status: number;
  reason: string | null;
  constructor(
    kind: DriveErrorKind,
    message: string,
    status = 0,
    reason: string | null = null,
  ) {
    super(message);
    this.name = "DriveError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export function googleOAuthConfig(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    throw new DriveError(
      "permanent",
      "Google Drive isn't configured on the server (missing OAuth client).",
    );
  }
  return { clientId, clientSecret };
}

// The redirect URI Google sends the browser back to. MUST match a URI registered
// on the OAuth client in the Google Cloud console, per Supabase project.
export function driveRedirectUri(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/drive-oauth-callback`;
}

// ── PKCE + state ─────────────────────────────────────────────────────────────
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

// `access_type=offline` + `prompt=consent` are what actually produce a REFRESH
// token (without both, a re-consent returns only an access token and the
// server-side background upload silently stops working).
export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function postToken(params: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e) {
    throw new DriveError(
      "transient",
      `Couldn't reach Google: ${(e as Error)?.message ?? e}`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    // invalid_grant = the refresh token is dead (owner revoked access, changed
    // their password, or the app was left in "Testing" so the token aged out).
    // Retrying can never fix it — the owner has to reconnect.
    const reason = data?.error ?? `status ${res.status}`;
    const kind: DriveErrorKind = reason === "invalid_grant"
      ? "auth"
      : res.status >= 500
      ? "transient"
      : "permanent";
    throw new DriveError(
      kind,
      data?.error_description ?? `Google token request failed (${reason})`,
      res.status,
      reason,
    );
  }
  return data;
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ refreshToken: string | null; accessToken: string | null }> {
  const { clientId, clientSecret } = googleOAuthConfig();
  const data = await postToken(
    new URLSearchParams({
      code: opts.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code_verifier: opts.verifier,
    }),
  );
  return {
    refreshToken: data.refresh_token ?? null,
    accessToken: data.access_token ?? null,
  };
}

export async function mintAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = googleOAuthConfig();
  const data = await postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  );
  if (!data.access_token) {
    throw new DriveError("auth", "Google returned no access token.");
  }
  return data.access_token;
}

// Best-effort revoke on disconnect. Google treats an already-dead token as an
// error; that's fine — we delete our copy either way.
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ── Drive REST ───────────────────────────────────────────────────────────────
async function driveFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (e) {
    throw new DriveError(
      "transient",
      `Couldn't reach Google Drive: ${(e as Error)?.message ?? e}`,
    );
  }
  if (res.ok) return res;

  const text = await res.text().catch(() => "");
  let reason: string | null = null;
  let message = text || `status ${res.status}`;
  try {
    const parsed = JSON.parse(text);
    reason = parsed?.error?.errors?.[0]?.reason ?? parsed?.error?.status ?? null;
    message = parsed?.error?.message ?? message;
  } catch (_) {
    /* non-JSON body — keep the raw text */
  }

  let kind: DriveErrorKind = "permanent";
  if (res.status === 401) kind = "auth";
  else if (res.status === 404) kind = "not_found";
  else if (res.status === 429) kind = "rate";
  else if (res.status >= 500) kind = "transient";
  else if (res.status === 403) {
    if (reason === "storageQuotaExceeded") kind = "quota";
    else if (
      reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded"
    ) kind = "rate";
    else kind = "permanent";
  }
  throw new DriveError(kind, message, res.status, reason);
}

// Drive filenames: '/' is the one character that genuinely breaks paths, but
// control characters and runaway length make for unusable folders too.
export function sanitizeName(input: string, max = 120): string {
  const cleaned = (input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
  return safe || "Untitled";
}

// The signed-in Google account. Authorized by drive.file (about.get accepts any
// Drive scope), so this needs no extra profile scope. Non-fatal for the caller:
// a null email only costs us the "Connected as …" label.
export async function fetchAccountInfo(
  accessToken: string,
): Promise<{ email: string | null }> {
  try {
    const res = await driveFetch(
      accessToken,
      `${DRIVE_API}/about?fields=user(emailAddress)`,
    );
    const data = await res.json().catch(() => ({}));
    return { email: data?.user?.emailAddress ?? null };
  } catch (_) {
    return { email: null };
  }
}

export async function createFolder(
  accessToken: string,
  name: string,
  parentId: string | null,
): Promise<string> {
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const res = await driveFetch(accessToken, `${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data?.id) throw new DriveError("permanent", "Drive returned no folder id.");
  return data.id as string;
}

// Confirm a remembered folder still exists (and isn't in the trash). `drive.file`
// can only see what we made, so a 404 here means the inspector deleted it —
// the runner recreates it rather than failing.
export async function getFolder(
  accessToken: string,
  folderId: string,
): Promise<{ id: string; name: string; parents: string[]; trashed: boolean } | null> {
  try {
    const res = await driveFetch(
      accessToken,
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,parents,trashed`,
    );
    const data = await res.json();
    return {
      id: data.id,
      name: data.name ?? "",
      parents: data.parents ?? [],
      trashed: !!data.trashed,
    };
  } catch (e) {
    if (e instanceof DriveError && e.kind === "not_found") return null;
    throw e;
  }
}

// Rename and/or re-parent in place — the SAME folder id survives, so an address
// edit or a date change across a year boundary moves the existing folder instead
// of orphaning it and creating a duplicate.
export async function updateFolderPlacement(
  accessToken: string,
  folderId: string,
  opts: { name?: string; addParent?: string; removeParent?: string },
): Promise<void> {
  const params = new URLSearchParams({ fields: "id" });
  if (opts.addParent) params.set("addParents", opts.addParent);
  if (opts.removeParent) params.set("removeParents", opts.removeParent);
  const body = opts.name ? JSON.stringify({ name: opts.name }) : "{}";
  await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}?${params.toString()}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    },
  );
}

function multipartBody(
  metadata: Record<string, unknown>,
  mimeType: string,
  bytes: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const boundary = `zanbi-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export async function uploadFile(
  accessToken: string,
  opts: {
    name: string;
    parentId: string;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<string> {
  const { body, contentType } = multipartBody(
    { name: opts.name, parents: [opts.parentId] },
    opts.mimeType,
    opts.bytes,
  );
  const res = await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
    { method: "POST", headers: { "Content-Type": contentType }, body },
  );
  const data = await res.json();
  if (!data?.id) throw new DriveError("permanent", "Drive returned no file id.");
  return data.id as string;
}

// Overwrite an existing file's CONTENT in place. Drive keeps the previous bytes
// as a revision, so a re-generated report replaces the PDF instead of producing
// "Final_Report (1).pdf" — that's what makes the folder a mirror.
export async function updateFileContent(
  accessToken: string,
  fileId: string,
  opts: { mimeType: string; bytes: Uint8Array; name?: string },
): Promise<void> {
  await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
    {
      method: "PATCH",
      headers: { "Content-Type": opts.mimeType },
      body: opts.bytes,
    },
  );
  if (opts.name) {
    await driveFetch(
      accessToken,
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: opts.name }),
      },
    );
  }
}

// Removing a photo from an inspection removes it from Drive — but to the TRASH,
// never a hard delete. A bug in our diff can then never destroy an inspector's
// retention records; everything stays recoverable on their side for 30 days.
export async function trashFile(
  accessToken: string,
  fileId: string,
): Promise<void> {
  try {
    await driveFetch(
      accessToken,
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
    );
  } catch (e) {
    // Already gone is success for our purposes.
    if (e instanceof DriveError && e.kind === "not_found") return;
    throw e;
  }
}
