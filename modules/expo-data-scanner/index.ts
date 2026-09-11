// JS surface for the local VisionKit DataScanner module (iOS-only native impl).
// Safe to import on any platform: when the native module is absent (Android,
// web), `isSupported()` resolves false and `DataScannerView` is null, so callers
// fall back cleanly. The React layer only ever renders the view on iOS via
// ScannerHost.ios, but these guards keep an accidental import from crashing.
import {
  requireNativeViewManager,
  requireOptionalNativeModule,
} from "expo-modules-core";
import { Platform } from "react-native";

const nativeModule = requireOptionalNativeModule("ExpoDataScanner");

export async function isSupported(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.isSupported();
  } catch {
    return false;
  }
}

let view: any = null;
if (nativeModule && Platform.OS === "ios") {
  try {
    view = requireNativeViewManager("ExpoDataScanner");
  } catch {
    view = null;
  }
}

// Native view. Props: recognizedTypes: "text" | "codes" | "both".
// Events: onItemTap({ nativeEvent: { kind: "text"|"barcode"|"qr", value } }).
export const DataScannerView = view;
