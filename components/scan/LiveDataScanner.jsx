import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../../db/logs";
import { DataScannerView } from "../../modules/expo-data-scanner";
import ScanReview from "./ScanReview";

// iOS-only live scanner over VisionKit's DataScannerViewController. Live text +
// barcode/QR with tap-to-select: nothing is committed until the inspector taps
// the exact item, so meaningless header text is simply never tapped. A mode
// filter narrows what's highlighted; multi-select accumulates model + serial in
// one pass. Contract: onComplete(items[]), onCancel(). Rendered ONLY when the
// native module reports isSupported (ScannerHost.ios decides); guards anyway.

const MODES = [
  { id: "codes", label: "Code" },
  { id: "text", label: "Text" },
  { id: "both", label: "Both" },
];
const KIND_LABEL = { barcode: "Barcode", qr: "QR", text: "Text" };
let seq = 0;
const itemId = () => `lv_${Date.now()}_${seq++}`;

export default function LiveDataScanner({ onComplete, onCancel }) {
  const [mode, setMode] = useState("codes");
  const [items, setItems] = useState([]);
  const [phase, setPhase] = useState("scan"); // scan | review
  const [captureToken, setCaptureToken] = useState(0);
  const [photoUri, setPhotoUri] = useState(null);
  const capturedRef = useRef(false);

  function handleTap(e) {
    const payload = e?.nativeEvent ?? {};
    const value = (payload.value ?? "").trim();
    if (!value) return;
    setItems((prev) => {
      if (prev.some((it) => it.value === value)) return prev; // dedupe
      const kind = payload.kind ?? "text";
      return [
        ...prev,
        { id: itemId(), kind, label: KIND_LABEL[kind] ?? "Scan", value },
      ];
    });
    // Snap the tag photo once, the moment the first item is captured, so it's
    // ready by the time they review. capturePhoto returns via onPhotoCaptured.
    if (!capturedRef.current) {
      capturedRef.current = true;
      setCaptureToken(Date.now());
    }
  }

  function handlePhoto(e) {
    const uri = e?.nativeEvent?.uri;
    if (uri) setPhotoUri(uri);
  }

  function changeItem(id, value) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, value } : it)));
  }
  function removeItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  if (phase === "review") {
    return (
      <ScanReview
        items={items}
        onChange={changeItem}
        onRemove={removeItem}
        onUse={() =>
          onComplete?.(
            items.filter((it) => (it.value ?? "").trim()),
            photoUri,
          )
        }
        onCancel={onCancel}
        onRetake={() => setPhase("scan")}
      />
    );
  }

  return (
    <View style={styles.container}>
      {DataScannerView ? (
        <DataScannerView
          style={StyleSheet.absoluteFill}
          recognizedTypes={mode}
          captureToken={captureToken}
          onItemTap={handleTap}
          onPhotoCaptured={handlePhoto}
          onError={(e) =>
            logError(
              new Error(e?.nativeEvent?.message ?? "scanner error"),
              "LiveDataScanner.onError",
            )
          }
        />
      ) : (
        <View style={styles.noView}>
          <Text style={styles.noViewTxt}>Scanner unavailable.</Text>
        </View>
      )}

      {/* Top bar: close + mode filter */}
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
          Tap the serial, model, or barcode — pinch to zoom
        </Text>
      </SafeAreaView>

      {/* Selected tray + Use */}
      <SafeAreaView edges={["bottom"]} style={styles.tray}>
        {items.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {items.map((it) => (
              <TouchableOpacity
                key={it.id}
                style={styles.chip}
                onPress={() => removeItem(it.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.chipTxt} numberOfLines={1}>
                  {it.value}
                </Text>
                <MaterialCommunityIcons name="close" size={14} color="#fff" />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <TouchableOpacity
          style={[styles.useBtn, items.length === 0 && styles.useDisabled]}
          onPress={() => setPhase("review")}
          disabled={items.length === 0}
          activeOpacity={0.85}
        >
          <Text style={styles.useTxt}>
            {items.length === 0
              ? "Tap an item to capture"
              : `Review & use (${items.length})`}
          </Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  noView: { flex: 1, alignItems: "center", justifyContent: "center" },
  noViewTxt: { color: "#fff", fontSize: 15 },

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
  segBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  segBtnOn: { backgroundColor: "#fff" },
  segTxt: { fontSize: 13, fontWeight: "700", color: "#fff" },
  segTxtOn: { color: theme?.colors?.primary },
  hint: {
    textAlign: "center",
    color: "#fff",
    fontSize: 12.5,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowRadius: 4,
  },

  tray: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme?.spacing?.m,
    paddingBottom: theme?.spacing?.m,
    paddingTop: theme?.spacing?.s,
    gap: 10,
  },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme?.colors?.primary,
  },
  chipTxt: { color: "#fff", fontSize: 13, fontWeight: "600", flexShrink: 1 },
  useBtn: {
    backgroundColor: theme?.colors?.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  useDisabled: { backgroundColor: "rgba(0,0,0,0.5)" },
  useTxt: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
