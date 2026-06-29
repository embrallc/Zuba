import { NativeModules } from "react-native";
import { logError } from "../db/logs";
import { syncAll } from "./sync";

// NetInfo is intentionally NOT imported at the top, and we don't even require()
// it blindly. The @react-native-community/netinfo package THROWS at module-
// evaluation time when the native module isn't in the binary (a dev client
// built before the dependency was added). Crucially, a try/catch around the
// require can't save us: Metro's dev module loader reports that eval throw as a
// FATAL via ErrorUtils.reportFatalError BEFORE re-throwing to our catch, so the
// global error handler still surfaces it. The only clean guard is to detect the
// native module the EXACT way netinfo does — NativeModules.RNCNetInfo — and skip
// loading the package entirely when it's absent. (If that's falsy, netinfo
// couldn't work anyway, so this agrees with the package 1:1.)

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
  // Bail BEFORE touching the netinfo package if its native module isn't in this
  // binary — otherwise requiring it would trigger a Metro fatal we can't catch.
  if (!NativeModules?.RNCNetInfo) {
    console.log(
      "[connectivity] NetInfo native module not in this binary; skipping watch until a rebuild.",
    );
    return;
  }

  try {
    const mod = require("@react-native-community/netinfo");
    const NetInfo = mod?.default ?? mod;
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
