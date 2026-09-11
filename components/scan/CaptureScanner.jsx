import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import TextRecognition from "@react-native-ml-kit/text-recognition";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../../db/logs";
import ScanReview from "./ScanReview";

// Fallback scan engine: capture a still → on-device ML Kit OCR → review the
// recognized lines (edit / prune "HR"-style noise) → hand items back. Used on
// Android, older iOS devices, and the simulator — anywhere VisionKit's live
// DataScanner isn't available. Contract: onComplete(items[]), onCancel().
//   item = { id, kind:"text", label, value }

const OCR_MAX_DIMENSION = 2600; // keep small print legible; bound memory
// expo-camera barcode/QR types (cross-platform — Google code scanner on Android,
// VisionKit on iOS). Gives the fallback real code scanning too.
const BARCODE_TYPES = [
  "qr", "ean13", "ean8", "upc_a", "upc_e", "code39", "code93",
  "code128", "itf14", "codabar", "datamatrix", "pdf417", "aztec",
];
// Two explicit modes so live code-detection and shutter-based text capture don't
// fight each other (Code auto-detects; Text disables detection, shutter only).
const MODES = [
  { id: "codes", label: "Code" },
  { id: "text", label: "Text" },
];
let seq = 0;
const itemId = () => `sc_${Date.now()}_${seq++}`;

async function prepForOcr(uri) {
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: OCR_MAX_DIMENSION } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
    );
    return out?.uri ?? uri;
  } catch (e) {
    logError(e, "CaptureScanner.prepForOcr");
    return uri;
  }
}

// Flatten ML Kit blocks → deduped, trimmed non-empty lines (one editable item
// each). An empty result yields a single blank row so the inspector can type.
function itemsFromResult(result) {
  const lines = [];
  const seen = new Set();
  for (const block of result?.blocks ?? []) {
    for (const line of block?.lines ?? []) {
      const t = (line?.text ?? "").trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        lines.push(t);
      }
    }
  }
  if (lines.length === 0) {
    const whole = (result?.text ?? "").trim();
    if (whole) lines.push(whole);
  }
  if (lines.length === 0) {
    return [{ id: itemId(), kind: "text", label: "Data plate", value: "" }];
  }
  return lines.map((value) => ({
    id: itemId(),
    kind: "text",
    label: "Text",
    value,
  }));
}

export default function CaptureScanner({ onComplete, onCancel }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const handlingRef = useRef(false);
  const [phase, setPhase] = useState("capture"); // capture | working | review
  const [items, setItems] = useState([]);
  const [photoUri, setPhotoUri] = useState(null);
  const [mode, setMode] = useState("codes"); // codes | text

  // Shutter → still → OCR (text). The still doubles as the tag photo.
  async function handleCapture() {
    if (phase !== "capture" || !cameraRef.current || handlingRef.current) return;
    handlingRef.current = true;
    setPhase("working");
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: true,
      });
      setPhotoUri(photo.uri);
      const ocrUri = await prepForOcr(photo.uri);
      let result = null;
      try {
        result = await TextRecognition.recognize(ocrUri);
      } catch (e) {
        logError(e, "CaptureScanner.recognize");
      }
      setItems(itemsFromResult(result ?? {}));
      setPhase("review");
    } catch (e) {
      logError(e, "CaptureScanner.handleCapture");
      setPhase("capture");
    } finally {
      handlingRef.current = false;
    }
  }

  // Live barcode/QR. Fires repeatedly while a code is in frame, so the ref +
  // phase guard keep it to a single capture. Also grabs a still for the tag photo.
  async function handleBarcode({ type, data }) {
    if (phase !== "capture" || handlingRef.current) return;
    const value = (data ?? "").trim();
    if (!value) return;
    handlingRef.current = true;
    setPhase("working");
    try {
      let uri = null;
      try {
        const photo = await cameraRef.current?.takePictureAsync({
          quality: 0.9,
          skipProcessing: true,
        });
        uri = photo?.uri ?? null;
      } catch (_) {
        // photo is best-effort; the code value is what matters
      }
      if (uri) setPhotoUri(uri);
      const kind = /qr/i.test(type) ? "qr" : "barcode";
      setItems([
        { id: itemId(), kind, label: kind === "qr" ? "QR" : "Barcode", value },
      ]);
      setPhase("review");
    } catch (e) {
      logError(e, "CaptureScanner.handleBarcode");
      setPhase("capture");
    } finally {
      handlingRef.current = false;
    }
  }

  function changeItem(id, value) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, value } : it)));
  }
  function removeItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }
  function retake() {
    setItems([]);
    setPhotoUri(null);
    handlingRef.current = false;
    setPhase("capture");
  }
  function use() {
    onComplete?.(items.filter((it) => (it.value ?? "").trim()), photoUri);
  }

  if (!permission) return <View style={styles.bg} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permScreen} edges={["top", "bottom"]}>
        <MaterialCommunityIcons name="barcode-scan" size={44} color="#fff" />
        <Text style={styles.permText}>
          Camera access is needed to scan a data plate.
        </Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.permBtn, styles.cancelBtn]}
          onPress={onCancel}
        >
          <Text style={styles.permBtnText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (phase === "review") {
    return (
      <ScanReview
        items={items}
        onChange={changeItem}
        onRemove={removeItem}
        onUse={use}
        onCancel={onCancel}
        onRetake={retake}
      />
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        onBarcodeScanned={
          mode === "codes" && phase === "capture" ? handleBarcode : undefined
        }
      />

      <SafeAreaView edges={["top"]} style={styles.topBar}>
        <View style={styles.topRow}>
          <TouchableOpacity
            onPress={onCancel}
            hitSlop={theme?.layout?.hitSlop?.medium}
            style={styles.topBtn}
          >
            <MaterialCommunityIcons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={styles.segment}>
            {MODES.map((m) => {
              const on = m.id === mode;
              return (
                <TouchableOpacity
                  key={m.id}
                  onPress={() => setMode(m.id)}
                  style={[styles.segBtn, on && styles.segBtnOn]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.segTxt, on && styles.segTxtOn]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{ width: 34 }} />
        </View>
        <Text style={styles.hint}>
          {mode === "codes"
            ? "Point at a barcode or QR"
            : "Snap the plate for text"}
        </Text>
      </SafeAreaView>

      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={styles.frame} />
      </View>

      {phase === "working" ? (
        <View style={styles.workingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.workingText}>Reading…</Text>
        </View>
      ) : mode === "text" ? (
        <SafeAreaView edges={["bottom"]} style={styles.shutterArea}>
          <TouchableOpacity
            onPress={handleCapture}
            activeOpacity={0.7}
            style={styles.shutterOuter}
          >
            <View style={styles.shutterInner}>
              <MaterialCommunityIcons
                name="camera"
                size={26}
                color={theme?.colors?.primary}
              />
            </View>
          </TouchableOpacity>
        </SafeAreaView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#000" },
  container: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },

  permScreen: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.m,
  },
  permText: {
    ...theme?.typography?.body,
    color: "#fff",
    textAlign: "center",
    marginHorizontal: theme?.spacing?.l,
    marginBottom: theme?.spacing?.s,
  },
  permBtn: {
    backgroundColor: theme?.colors?.primary,
    paddingHorizontal: theme?.spacing?.l,
    paddingVertical: theme?.spacing?.s,
    borderRadius: theme?.layout?.borderRadius?.m,
  },
  cancelBtn: { backgroundColor: "rgba(255,255,255,0.15)" },
  permBtnText: { ...theme?.typography?.bodyBold, color: "#fff" },

  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.s,
    gap: 8,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topBtn: {
    padding: theme?.spacing?.xs,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: theme?.layout?.borderRadius?.m,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 999,
    padding: 3,
  },
  segBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 999 },
  segBtnOn: { backgroundColor: "#fff" },
  segTxt: { fontSize: 13, fontWeight: "700", color: "#fff" },
  segTxtOn: { color: theme?.colors?.primary },
  hint: {
    textAlign: "center",
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  frameWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    width: "78%",
    height: "42%",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
    borderRadius: 16,
  },
  workingOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 150,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  workingText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  shutterArea: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingBottom: theme?.spacing?.l,
    paddingTop: theme?.spacing?.s,
  },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
