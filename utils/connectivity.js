import { logError } from "../db/logs";
import { syncAll } from "./sync";

// NetInfo is intentionally NOT imported at the top. It's a native module, and
// its package throws at module-evaluation time when the native binary doesn't
// include it (an old dev client not yet rebuilt). A top-level import would run
// that throw during boot's module graph load — before any try/catch — and
// white-screen the whole app. We lazy-require it inside startConnectivityWatch
// instead, so a missing module is caught there and degrades gracefully.

// Network-state awareness. The app is offline-first: local edits to owned data
// queue via the `Synced = 0` dirty flag and push on the next syncAll. The job
// here is to fire that flush the MOMENT connectivity returns — instead of
// waiting for the next manual trigger (app open, pull-to-refresh) — and to
// expose isOnline() so server-authoritative actions (reassign, role/settings
// changes) can fail fast with a clear message instead of a raw network error.

// Default to online: NetInfo reports null/unknown briefly at startup, and we
// never want an undetermined state to block an action or suppress a sync.
let online = true;

export function isOnline() {
  return online;
}

// isInternetReachable can be null while the reachability probe is pending — only
// an explicit `false` on either field counts as offline, so a slow probe can't
// make the flag flap.
function isStateOnline(state) {
  return state?.isConnected !== false && state?.isInternetReachable !== false;
}

let unsubscribe = null;

// Subscribe once at boot. On an offline -> online edge, flush the dirty queue
// with syncAll() (idempotent + re-entrancy guarded, so it coalesces with any
// boot/refresh sync already in flight rather than duplicating it).
export function startConnectivityWatch() {
  if (unsubscribe) return;
  // Lazy-require so a binary missing the native module is handled HERE instead
  // of crashing at a top-level import. A stale dev client may not THROW — it can
  // hand back an undefined/partial module — so we feature-check before using it.
  let NetInfo;
  try {
    const mod = require("@react-native-community/netinfo");
    NetInfo = mod?.default ?? mod;
  } catch (e) {
    console.log("[connectivity] NetInfo unavailable; skipping watch:", e?.message);
    return;
  }
  if (!NetInfo || typeof NetInfo.addEventListener !== "function") {
    // Module resolved but the native side isn't linked into this binary (an old
    // dev client not yet rebuilt). isOnline() keeps its safe `true` default, so
    // nothing is wrongly blocked offline — just skip the watch until a rebuild.
    console.log("[connectivity] NetInfo native module missing; skipping watch.");
    return;
  }

  try {
    unsubscribe = NetInfo.addEventListener((state) => {
      const next = isStateOnline(state);
      const cameOnline = next && !online;
      online = next;
      if (cameOnline) {
        try {
          syncAll();
        } catch (e) {
          logError(e, "connectivity/flushOnReconnect");
        }
      }
    });
  } catch (e) {
    // NetInfo is a native module; if the running binary predates its install
    // (an old dev client not yet rebuilt), don't let that crash boot. isOnline()
    // stays true (its safe default), so no action is wrongly blocked offline.
    logError(e, "connectivity/start");
  }
}

export function stopConnectivityWatch() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
