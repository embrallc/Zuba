import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

// One-trial-per-device anchor. A UUID minted once per device and stored in
// SecureStore — on iOS that's the keychain, which SURVIVES app uninstall and
// reinstall, so "delete the app, sign up with a new email" doesn't grant a
// fresh trial. The server only ever sees a SHA-256 of this value.
//
// Failure here must never block the app: if SecureStore is unavailable we
// return null and the server simply skips the device check.

const ANCHOR_KEY = "kensa_trial_anchor_v1";

let cached = null;

export async function getTrialAnchor() {
  if (cached) return cached;
  try {
    let anchor = await SecureStore.getItemAsync(ANCHOR_KEY);
    if (!anchor) {
      anchor = Crypto.randomUUID();
      await SecureStore.setItemAsync(ANCHOR_KEY, anchor, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    }
    cached = anchor;
    return anchor;
  } catch (_e) {
    return null;
  }
}
