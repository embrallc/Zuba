import { create } from "zustand";

export const ENTITLEMENT_ID = "Embra LLC Pro";

export const useSubscriptionStore = create((set) => ({
  isPro: false,
  customerInfo: null,

  setCustomerInfo: (customerInfo) =>
    set({
      customerInfo,
      isPro:
        typeof customerInfo?.entitlements?.active[ENTITLEMENT_ID] !==
        "undefined",
    }),
}));
