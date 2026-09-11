import { theme } from "@theme";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { logError } from "../../db/logs";
import { isSupported } from "../../modules/expo-data-scanner";
import CaptureScanner from "./CaptureScanner";
import LiveDataScanner from "./LiveDataScanner";

// iOS scanner entry. Picks the engine ONCE up front — the only runtime
// capability branch in the whole feature. VisionKit's DataScanner needs iOS 16
// + an A12 device; anywhere it isn't available (older device, simulator) we
// fall back to the ML Kit capture flow. Contract: onComplete(items[]), onCancel().
// DEV-ONLY test switch. Flip to true to force the ML Kit capture fallback on a
// device that actually supports DataScanner (e.g. testing the Android/older-device
// path on a single supported iPhone). Both engines are in the same build, so this
// is a JS-only flip — Fast Refresh, no rebuild. Ignored outside __DEV__, so it can
// never ship forced. Set back to false to use the DataScanner path.
const FORCE_CAPTURE_FALLBACK = false;

export default function ScannerHost({ onComplete, onCancel }) {
  const [engine, setEngine] = useState(null); // null = checking | "live" | "capture"

  useEffect(() => {
    let alive = true;
    if (__DEV__ && FORCE_CAPTURE_FALLBACK) {
      setEngine("capture");
      return () => {
        alive = false;
      };
    }
    (async () => {
      let ok = false;
      try {
        ok = await isSupported();
      } catch (e) {
        logError(e, "ScannerHost.isSupported");
      }
      if (alive) setEngine(ok ? "live" : "capture");
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (engine === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      </View>
    );
  }

  return engine === "live" ? (
    <LiveDataScanner onComplete={onComplete} onCancel={onCancel} />
  ) : (
    <CaptureScanner onComplete={onComplete} onCancel={onCancel} />
  );
}

const styles = {
  loading: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
};
