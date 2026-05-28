// Top-of-screen notification banner — a tiny global state store + companion
// imperative helper so any module (component or not) can drop a banner.
//
// Usage from a component:
//   const show = useBannerStore((s) => s.show);
//   show({ message: "Saved", kind: "success" });
//
// Usage from a plain JS module (utils/sync.js, etc.):
//   import { showBanner } from "../stores/useBannerStore";
//   showBanner({ message: "Sync network not ready...", kind: "warning" });
//
// `kind` controls icon + accent color. Pass duration: 0 for sticky banners
// the user must dismiss manually.

import { create } from "zustand";

let dismissTimer = null;

function normalize(input) {
  if (!input) return { message: "" };
  if (typeof input === "string") return { message: input };
  return input;
}

export const useBannerStore = create((set, get) => ({
  visible: false,
  message: "",
  kind: "info", // 'info' | 'warning' | 'error' | 'success'
  // Optional CTA shown on the right side. Shape: { label, onPress }.
  // onPress fires before the banner is dismissed.
  action: null,

  show: (input) => {
    const {
      message = "",
      kind = "info",
      duration = 4000,
      action = null,
    } = normalize(input);
    if (!message) return;
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ visible: true, message, kind, action });
    if (duration > 0) {
      dismissTimer = setTimeout(() => {
        set({ visible: false, action: null });
        dismissTimer = null;
      }, duration);
    }
  },

  hide: () => {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ visible: false, action: null });
  },
}));

// Imperative helper for non-component callers. Re-exported so consumers
// don't have to know about the store internals.
export function showBanner(input) {
  useBannerStore.getState().show(input);
}

export function hideBanner() {
  useBannerStore.getState().hide();
}
