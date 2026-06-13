import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { logError } from "../db/logs";
import { supabase } from "../utils/supabase";
import { getTrialAnchor } from "../utils/trialAnchor";

export const ENTITLEMENT_ID = "Embra LLC Pro";

// Last server verdict is persisted so the gate works offline: an expired org
// stays locked in airplane mode, and a paid org isn't locked by a network
// blip. The SERVER is the only thing that computes state — the one local
// inference allowed is "the trial end the server told us about has passed".
const STORAGE_KEY = "subscription_status_v1";

export function isLocked(status) {
  if (!status) return false; // never fetched (fresh install mid-login) — let the fetch decide
  if (status.state === "expired" || status.state === "seat_locked") return true;
  if (status.state === "trial") {
    const end = Date.parse(status.trialEndsAt);
    return Number.isFinite(end) && end < Date.now();
  }
  return false;
}

export const useSubscriptionStore = create((set, get) => ({
  // Server response from subscription-status:
  // { state, role, daysLeft, seats, members, seatsExceeded,
  //   trialEndsAt, periodEndsAt, productId }
  status: null,
  hydrated: false,
  refreshing: false,
  customerInfo: null,

  setCustomerInfo: (customerInfo) => set({ customerInfo }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) set({ status: JSON.parse(raw) });
    } catch (e) {
      logError(e, "useSubscriptionStore.hydrate");
    } finally {
      set({ hydrated: true });
    }
  },

  // sync:true is for the moment right after an owner purchase — the server
  // pulls RevenueCat's REST truth instead of waiting on the webhook.
  refreshStatus: async ({ sync = false } = {}) => {
    if (get().refreshing) return get().status;
    set({ refreshing: true });
    try {
      const deviceAnchor = await getTrialAnchor();
      const { data, error } = await supabase.functions.invoke(
        "subscription-status",
        { body: { deviceAnchor, sync } },
      );
      if (error) throw error;
      if (data?.state) {
        set({ status: data });
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data)).catch(() => {});
      }
      return data ?? null;
    } catch (e) {
      // Fail open: a fetch failure keeps the last persisted verdict in force
      // rather than locking a paying user out over a dead connection.
      logError(e, "useSubscriptionStore.refreshStatus");
      return null;
    } finally {
      set({ refreshing: false });
    }
  },

  clear: () => {
    set({ status: null, customerInfo: null });
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },
}));
