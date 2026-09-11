import CaptureScanner from "./CaptureScanner";

// Android scanner entry. VisionKit's DataScanner is iOS-only, so Android uses
// the ML Kit capture+OCR flow. (A future live barcode path via expo-camera's
// Google Code Scanner can slot in here without touching the rest of the feature.)
// Contract: onComplete(items[]), onCancel().
export default function ScannerHost({ onComplete, onCancel }) {
  return <CaptureScanner onComplete={onComplete} onCancel={onCancel} />;
}
