import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { AppState, LogBox } from "react-native";

// SecureStore has a 2KB per-key limit, so large tokens are chunked.
const SecureStoreAdapter = {
  getItem: async (key) => {
    try {
      const chunkCount = await SecureStore.getItemAsync(`${key}.chunks`);
      if (chunkCount === null) return SecureStore.getItemAsync(key);
      const chunks = await Promise.all(
        Array.from({ length: parseInt(chunkCount, 10) }, (_, i) =>
          SecureStore.getItemAsync(`${key}.chunk.${i}`)
        )
      );
      return chunks.join("");
    } catch (e) {
      // Returning null here causes Supabase to treat the user as logged
      // out — surface the reason so we can tell whether it's a real corruption
      // or a transient SecureStore error.
      console.warn(`[SecureStore] getItem failed for key=${key}:`, e?.message);
      return null;
    }
  },

  setItem: async (key, value) => {
    try {
      const size = 1800; // stay safely under the 2KB limit
      if (value.length <= size) {
        await SecureStore.setItemAsync(key, value);
        // If the previous value was chunked, remove the chunk keys too —
        // not just the marker — so stale fragments can't linger in the
        // keychain forever.
        const oldCount = await SecureStore.getItemAsync(`${key}.chunks`).catch(
          () => null,
        );
        if (oldCount !== null && oldCount !== undefined) {
          const n = parseInt(oldCount, 10) || 0;
          await Promise.all(
            Array.from({ length: n }, (_, i) =>
              SecureStore.deleteItemAsync(`${key}.chunk.${i}`).catch(() => {}),
            ),
          );
        }
        await SecureStore.deleteItemAsync(`${key}.chunks`).catch(() => {});
        return;
      }
      const chunks = [];
      for (let i = 0; i < value.length; i += size) {
        chunks.push(value.slice(i, i + size));
      }
      await Promise.all(
        chunks.map((chunk, i) => SecureStore.setItemAsync(`${key}.chunk.${i}`, chunk))
      );
      await SecureStore.setItemAsync(`${key}.chunks`, String(chunks.length));
      await SecureStore.deleteItemAsync(key).catch(() => {});
    } catch (e) {
      console.warn(`[SecureStore] setItem failed for key=${key}:`, e.message);
    }
  },

  removeItem: async (key) => {
    try {
      const chunkCount = await SecureStore.getItemAsync(`${key}.chunks`);
      if (chunkCount !== null) {
        // Tolerate individual chunk-delete failures so one corrupt key can't
        // leave the rest behind.
        await Promise.all(
          Array.from({ length: parseInt(chunkCount, 10) }, (_, i) =>
            SecureStore.deleteItemAsync(`${key}.chunk.${i}`).catch(() => {}),
          ),
        );
        await SecureStore.deleteItemAsync(`${key}.chunks`).catch(() => {});
      }
      await SecureStore.deleteItemAsync(key).catch(() => {});
    } catch (e) {
      console.warn(`[SecureStore] removeItem failed for key=${key}:`, e?.message);
    }
  },
};

// Keys Supabase stores under the session storage key
const SESSION_KEY = "supabase.auth.token";
const SESSION_SUFFIXES = ["", "-user", "-code-verifier"];

async function nukeSecureStoreKey(key) {
  // Delete base key
  await SecureStore.deleteItemAsync(key).catch(() => {});
  // Delete chunked variant
  let count = null;
  try { count = await SecureStore.getItemAsync(`${key}.chunks`); } catch (_) {}
  if (count !== null) {
    const n = parseInt(count, 10);
    for (let i = 0; i < n; i++) {
      await SecureStore.deleteItemAsync(`${key}.chunk.${i}`).catch(() => {});
    }
    await SecureStore.deleteItemAsync(`${key}.chunks`).catch(() => {});
  }
  // Verify
  let remaining = null;
  try { remaining = await SecureStore.getItemAsync(key); } catch (_) {}
  if (remaining !== null) {
    console.warn(`[signOut] key still present after delete: ${key}`);
  } else {
    console.log(`[signOut] cleared: ${key}`);
  }
}

// Always clears local SecureStore keys, regardless of whether the server
// signOut call succeeds. Supabase's built-in signOut skips local removal
// if the server returns an unexpected error, which leaves the session alive.
export async function signOutAndClear() {
  const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  console.log("[signOut] session before clear:", session ? `expires_at=${session.expires_at}` : "null");

  const { error: signOutError } = await supabase.auth.signOut().catch((e) => ({ error: e }));
  if (signOutError) {
    console.warn("[signOut] signOut() returned error:", signOutError.message);
  }

  for (const suffix of SESSION_SUFFIXES) {
    await nukeSecureStoreKey(SESSION_KEY + suffix);
  }

  const { data: { session: remaining } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  console.log("[signOut] session after clear:", remaining ? "STILL PRESENT — BUG" : "null ✓");
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_KEY,
  {
    auth: {
      storage: SecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

// ─── Auth refresher lifecycle (React Native) ─────────────────────────────────
// autoRefreshToken runs on an internal timer. On RN that timer keeps ticking
// while the app is backgrounded — and fires again right on resume, before the
// network stack is back — so its /token fetch rejects with
// `TypeError: Network request failed` from inside GoTrue. Because the rejection
// happens in GoTrue's own timer callback (not one of our awaited calls), it
// surfaces as a context-less unhandled rejection (whatwg-fetch frame only) and,
// in the dev client, a LogBox redbox. It's benign — non-fatal, self-heals on the
// next tick, and invisible in release builds — but noisy.
//
// Supabase's documented RN fix: only run the refresher while the app is in the
// foreground. The client already auto-starts it on creation (app launches
// active), so we just pause on background/inactive and resume on active. Wrapped
// defensively so a listener hiccup can never break boot.
try {
  AppState.addEventListener("change", (state) => {
    try {
      if (state === "active") {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    } catch (_) {
      // start/stopAutoRefresh is best-effort; never let it throw into AppState.
    }
  });
} catch (_) {
  // AppState unavailable (shouldn't happen on device) — leave the default timer.
}

// Dev-only cosmetics: even with the fix above, an occasional resume-time fetch
// can still lose the network race and show a LogBox redbox in the dev client.
// LogBox is compiled out of release builds, so this only affects local testing —
// silence just that transient message so it doesn't interrupt QA. Real errors
// (any other message) still surface normally.
if (__DEV__) {
  try {
    LogBox.ignoreLogs(["Network request failed"]);
  } catch (_) {}
}
