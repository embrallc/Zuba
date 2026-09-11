import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Shared confirm/edit panel for a scan session — used by BOTH the live
// DataScanner (iOS) and the ML Kit capture fallback. Shows the picked items as
// editable rows (the small-text safety net: a wrong read is caught + fixed
// here, against the label the inspector just scanned) with per-row remove.
//   items      = [{ id, kind, label, value }]
//   onChange(id, value) · onRemove(id) · onUse() · onCancel() · onRetake?()

const KIND_ICON = {
  barcode: "barcode",
  qr: "qrcode",
  text: "text-recognition",
};

function ItemRow({ item, onChange, onRemove }) {
  const [text, setText] = useState(item?.value ?? "");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused && (item?.value ?? "") !== text) setText(item?.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.value]);

  const apply = (t) => {
    setText(t);
    onChange?.(item.id, t);
  };

  return (
    <View style={s.row}>
      <View style={s.rowHead}>
        <View style={s.rowLabel}>
          <MaterialCommunityIcons
            name={KIND_ICON[item?.kind] ?? "text-recognition"}
            size={14}
            color={theme?.colors?.primary}
          />
          <Text style={s.rowLabelTxt} numberOfLines={1}>
            {item?.label || "Scan"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => onRemove?.(item.id)}
          hitSlop={theme?.layout?.hitSlop?.medium}
          style={s.rowDel}
          accessibilityLabel="Remove item"
        >
          <MaterialCommunityIcons
            name="close"
            size={16}
            color={theme?.colors?.textSubtle}
          />
        </TouchableOpacity>
      </View>
      <TextInput
        style={s.rowInput}
        value={text}
        onChangeText={apply}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        multiline
        textAlignVertical="top"
        placeholder="Scanned value…"
        placeholderTextColor={theme?.colors?.textFine}
      />
    </View>
  );
}

export default function ScanReview({
  items = [],
  onChange,
  onRemove,
  onUse,
  onCancel,
  onRetake,
}) {
  const usable = items.some((it) => (it?.value ?? "").trim());

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={s.header}>
          <TouchableOpacity
            onPress={onCancel}
            hitSlop={theme?.layout?.hitSlop?.medium}
          >
            <MaterialCommunityIcons
              name="close"
              size={24}
              color={theme?.colors?.icon}
            />
          </TouchableOpacity>
          <Text style={s.title}>Review scan</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {items.length === 0 ? (
            <Text style={s.empty}>
              Nothing captured yet. Retake to try again.
            </Text>
          ) : (
            items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                onChange={onChange}
                onRemove={onRemove}
              />
            ))
          )}
        </ScrollView>

        <View style={s.actions}>
          {onRetake && (
            <TouchableOpacity
              style={[s.btn, s.ghost]}
              onPress={onRetake}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons
                name="camera-retake-outline"
                size={18}
                color={theme?.colors?.primary}
              />
              <Text style={s.ghostTxt}>Retake</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.btn, s.primary, !usable && s.disabled]}
            onPress={onUse}
            disabled={!usable}
            activeOpacity={0.85}
          >
            <Text style={s.primaryTxt}>
              Use {items.length > 1 ? `(${items.length})` : "scan"}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme?.colors?.mainBackground },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    ...theme?.shadows?.light,
  },
  title: { ...theme?.typography?.h4, color: theme?.colors?.text },
  scroll: { padding: theme?.spacing?.m, paddingBottom: 24, gap: 12 },
  empty: {
    fontSize: 14,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
    marginTop: 40,
  },
  row: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m ?? 12,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    padding: 12,
  },
  rowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  rowLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flex: 1,
    paddingRight: 8,
  },
  rowLabelTxt: {
    fontSize: 12.5,
    fontWeight: "700",
    letterSpacing: 0.2,
    color: theme?.colors?.primary,
  },
  rowDel: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme?.colors?.mainBackground,
  },
  rowInput: {
    backgroundColor: theme?.colors?.mainBackground,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: theme?.colors?.text,
    minHeight: 48,
    lineHeight: 21,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: theme?.spacing?.m,
    paddingTop: theme?.spacing?.s,
    paddingBottom: theme?.spacing?.m,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  ghost: {
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    backgroundColor: theme?.colors?.cardBackground,
  },
  ghostTxt: { fontSize: 14, fontWeight: "700", color: theme?.colors?.primary },
  primary: { flex: 1, backgroundColor: theme?.colors?.primary },
  primaryTxt: { fontSize: 14, fontWeight: "700", color: "#fff" },
  disabled: { opacity: 0.5 },
});
