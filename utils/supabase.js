import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

// SecureStore has a 2KB per-key limit, so large tokens are chunked.
const SecureStoreAdapter = {
  getItem: async (key) => {
    const chunkCount = await SecureStore.getItemAsync(`${key}.chunks`);
    if (chunkCount === null) return SecureStore.getItemAsync(key);
    const chunks = await Promise.all(
      Array.from({ length: parseInt(chunkCount, 10) }, (_, i) =>
        SecureStore.getItemAsync(`${key}.chunk.${i}`)
      )
    );
    return chunks.join("");
  },

  setItem: async (key, value) => {
    const size = 1800; // stay safely under the 2KB limit
    if (value.length <= size) {
      await SecureStore.setItemAsync(key, value);
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
  },

  removeItem: async (key) => {
    const chunkCount = await SecureStore.getItemAsync(`${key}.chunks`);
    if (chunkCount !== null) {
      await Promise.all(
        Array.from({ length: parseInt(chunkCount, 10) }, (_, i) =>
          SecureStore.deleteItemAsync(`${key}.chunk.${i}`)
        )
      );
      await SecureStore.deleteItemAsync(`${key}.chunks`);
    }
    await SecureStore.deleteItemAsync(key).catch(() => {});
  },
};

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
