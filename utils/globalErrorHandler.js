// Minimal global error capture (pre-launch we'll expand this into the full
// observability layer + cloud app_logs sync). For now it catches errors that
// escape every try/catch and routes them to logError — which prints to the
// console AND writes to the AppLogs table — so nothing fails silently.

import { logError } from "../db/logs";

let installed = false;

export function setupGlobalErrorHandler() {
  if (installed) return;
  installed = true;

  // Uncaught JS errors (the React Native global handler). Preserve the previous
  // handler so the dev redbox / fatal-crash reporting still fires.
  try {
    const g = global;
    if (g?.ErrorUtils?.getGlobalHandler && g?.ErrorUtils?.setGlobalHandler) {
      const prev = g.ErrorUtils.getGlobalHandler();
      g.ErrorUtils.setGlobalHandler((error, isFatal) => {
        try {
          logError(error, `globalError${isFatal ? ":fatal" : ""}`);
        } catch (_) {}
        if (typeof prev === "function") prev(error, isFatal);
      });
    }
  } catch (_) {
    // never let installing the handler crash boot
  }

  // Unhandled promise rejections. RN routes these through the bundled `promise`
  // polyfill's rejection tracker; hook it if present. Wrapped defensively since
  // the internal path can vary by RN version.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracking = require("promise/setimmediate/rejection-tracking");
    tracking.enable({
      allRejections: true,
      onUnhandled: (id, error) => {
        try {
          logError(error, `unhandledRejection:${id}`);
        } catch (_) {}
      },
      onHandled: () => {},
    });
  } catch (_) {
    // rejection-tracking not available in this build — skip
  }
}
