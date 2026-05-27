// Tiny pub/sub for db-layer events.
//
// db modules emit when a write completes; subscribers (notifications,
// analytics, etc.) live outside db/ and register from app/_layout.jsx so
// the db layer stays a pure SQLite wrapper.
//
// API:
//   subscribe(event, handler) → unsubscribe()
//   emit(event, payload)
//
// Sync vs async handlers are both supported. Errors are caught per-handler
// so one bad subscriber cannot break the emitter or sibling subscribers.

import { logError } from "./logs";

// event name → Set<handler>
const listeners = new Map();

export const DB_EVENTS = Object.freeze({
  INSPECTION_INSERTED: "inspection.inserted",
  INSPECTION_UPDATED: "inspection.updated",
  INSPECTION_DELETED: "inspection.deleted",
});

export function subscribe(event, handler) {
  if (typeof handler !== "function") {
    logError(
      new Error(`subscribe: handler is not a function for event=${event}`),
      "db/events.subscribe",
    );
    return () => {};
  }
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  // Returned closure is idempotent — calling it twice is harmless.
  return () => {
    listeners.get(event)?.delete(handler);
  };
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  // Snapshot to a plain array so a handler that unsubscribes itself mid-emit
  // doesn't mutate the iterating Set.
  const snapshot = Array.from(set);
  for (const handler of snapshot) {
    try {
      const result = handler(payload);
      if (result && typeof result.catch === "function") {
        result.catch((e) =>
          logError(e, `db/events.emit async handler event=${event}`),
        );
      }
    } catch (e) {
      logError(e, `db/events.emit sync handler event=${event}`);
    }
  }
}
