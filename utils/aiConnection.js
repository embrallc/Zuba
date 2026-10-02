import { logError, logEvent } from "../db/logs";
import { isOnline } from "./connectivity";
import { supabase } from "./supabase";

// Client-side wrappers for the ai-connection Edge Function ("Integrate your
// favorite AI"). Same shape as utils/drive.js. The key is generated and hashed
// server-side; the app only ever sees it once, right after creating it, and
// never stores it.

const INVOKE_TIMEOUT_MS = 30000;

async function invoke(body) {
  // Offline: fail instantly instead of waiting out the timeout below.
  if (!isOnline()) {
    const err = new Error("You're offline — connect to the internet and try again.");
    err.code = "offline";
    throw err;
  }
  let result;
  try {
    result = await Promise.race([
      supabase.functions.invoke("ai-connection", { body }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("The request timed out. Check your connection and try again."),
            ),
          INVOKE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (e) {
    logError(e, `utils/aiConnection.invoke ${body?.action} (timeout/transport)`);
    const err = new Error(e?.message || "Request failed. Please try again.");
    err.code = "timeout";
    throw err;
  }
  const { data, error } = result;
  if (error) {
    let code = error.message ?? "Something went wrong.";
    let detail = code;
    try {
      const parsed = await error.context?.json?.();
      if (parsed?.error) code = parsed.error;
      detail = parsed?.detail || parsed?.error || code;
    } catch (_) {}
    logError(error, `utils/aiConnection.invoke ${body?.action} code="${code}"`);
    const err = new Error(friendlyError(code, detail));
    err.code = code;
    throw err;
  }
  return data;
}

function friendlyError(code, detail) {
  switch (code) {
    case "already_connected":
      return "You already have an AI connection. Disable it first to create a new one.";
    case "unauthorized":
      return "Your session has expired. Please sign out and back in.";
    default:
      return detail || "Something went wrong. Please try again.";
  }
}

// { connected, keyPrefix, createdAt, lastUsedAt }
export async function getAiConnectionStatus() {
  return await invoke({ action: "status" });
}

// Creates the user's key and returns it. This is the only time the key is
// ever available — show/copy it now; it can't be fetched again.
export async function createAiConnection() {
  const data = await invoke({ action: "create" });
  if (!data?.key) throw new Error("No connection key came back. Please try again.");
  logEvent("ai.connected", {});
  return data.key;
}

// Deletes the key. Every AI app using it loses access on its next request.
export async function disableAiConnection() {
  const data = await invoke({ action: "disable" });
  logEvent("ai.disabled", {});
  return data;
}

// Where AI apps reach Zanbi's MCP server. Same base URL supabase-js uses, so it
// points at staging from the Dev build and at prod from the store build.
export function mcpServerUrl() {
  const base = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/mcp`;
}

// Today's date as YYYY-MM-DD in the phone's time zone, for the example call.
function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The text the user copies into their AI app's connector / MCP settings, or
// hands to a skill that calls Zanbi directly.
export function buildConnectionInstructions(key) {
  const url = mcpServerUrl();
  return `Zanbi connection for my AI assistant

Zanbi hosts an MCP (Model Context Protocol) server for my account.
Add it in your AI app's connector / MCP server settings:
  Server URL: ${url}
  Transport: Streamable HTTP
  Header: Authorization: Bearer ${key}

If your app uses an MCP config file:
{ "mcpServers": { "zanbi": { "type": "http", "url": "${url}",
  "headers": { "Authorization": "Bearer ${key}" } } } }

Calling it directly (from a skill or script): POST JSON-RPC 2.0 to the Server URL with the
Authorization header. No setup call is needed. First list the tools:
  curl -X POST ${url} -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Then call one by name with its arguments:
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"getTodaysInspections","arguments":{"date":"${todayYmd()}"}}}'

Once connected, call tools/list to see what Zanbi can do, then use those tools to answer my questions about my inspections.

Treat this key like a password: anyone who has it can use these Zanbi tools as me. I can turn it off any time in Zanbi → Settings → Integrate your favorite AI.`;
}
