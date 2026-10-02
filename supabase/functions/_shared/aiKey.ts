// AI connection keys — shared by ai-connection (creates them) and mcp (checks
// them), so a key can never be hashed two different ways.
//
// A key is "zanbi_ai_" + 64 hex characters (32 random bytes = 256 bits). Only
// its SHA-256 hash is stored. A fast hash is right here: the key is random and
// unguessable, so there's nothing to brute-force — slow hashing (bcrypt etc.)
// only matters for human-chosen passwords — and a plain hash lets the mcp
// function find the key with one indexed lookup.

export const KEY_PREFIX = "zanbi_ai_";

// How much of the key Settings shows so the user can recognize it
// ("zanbi_ai_1a2b…"). Never enough to use it.
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 4;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateKey(): string {
  return KEY_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return toHex(new Uint8Array(digest));
}

export function displayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH);
}
