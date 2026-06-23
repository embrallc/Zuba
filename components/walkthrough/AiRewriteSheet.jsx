import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

// Review surface for an AI rewrite. Shows the inspector's original note for
// reference, and the suggestion in an EDITABLE field so they can tweak before
// using it. Nothing is written to the answers until they tap "Use rewrite" —
// "Keep mine" leaves the field exactly as it was (their original is never lost).
//
// Deliberately NOT a <Modal>: it's rendered as an absolute-fill overlay so it
// can sit on top of the form OR inside the photo-viewer modal (where a second
// Modal wouldn't reliably present over the first). The host gates `visible`.
export default function AiRewriteSheet({
  visible,
  original,
  suggestion,
  loading,
  onChangeSuggestion,
  onRegenerate,
  onUse,
  onKeepMine,
}) {
  if (!visible) return null;
  return (
    <KeyboardAvoidingView
      style={s.overlay}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onKeepMine} />
      <View style={s.card}>
        <View style={s.header}>
          <MaterialCommunityIcons
            name="auto-fix"
            size={20}
            color={theme?.colors?.primary}
          />
          <Text style={s.title}>AI Rewrite</Text>
          <TouchableOpacity
            onPress={onKeepMine}
            hitSlop={theme?.layout?.hitSlop?.medium}
          >
            <MaterialCommunityIcons
              name="close"
              size={22}
              color={theme?.colors?.icon}
            />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={s.sectionLabel}>YOUR NOTE</Text>
          <View style={s.originalBox}>
            <Text style={s.originalText}>{original}</Text>
          </View>

          <Text style={[s.sectionLabel, { marginTop: 16 }]}>
            SUGGESTION{"  "}
            <Text style={s.editHint}>· tap to edit</Text>
          </Text>
          <View>
            <TextInput
              style={s.suggestionInput}
              value={suggestion}
              onChangeText={onChangeSuggestion}
              multiline
              editable={!loading}
              textAlignVertical="top"
              placeholder="Suggestion…"
              placeholderTextColor={theme?.colors?.textFine}
            />
            {loading && (
              <View style={s.loadingOverlay}>
                <ActivityIndicator color={theme?.colors?.primary} />
              </View>
            )}
          </View>
        </ScrollView>

        <View style={s.actions}>
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            onPress={onKeepMine}
            activeOpacity={0.8}
          >
            <Text style={s.btnGhostTxt}>Keep mine</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            onPress={onRegenerate}
            disabled={loading}
            activeOpacity={0.8}
          >
            <MaterialCommunityIcons
              name="refresh"
              size={16}
              color={theme?.colors?.primary}
            />
            <Text style={s.btnGhostTxt}>Regenerate</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnPrimary, loading && s.btnDisabled]}
            onPress={onUse}
            disabled={loading || !suggestion?.trim()}
            activeOpacity={0.85}
          >
            <Text style={s.btnPrimaryTxt}>Use rewrite</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    zIndex: 1000,
    elevation: 1000,
  },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  card: {
    backgroundColor: theme?.colors?.cardBackground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
    maxHeight: "82%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  title: {
    ...theme?.typography?.h4,
    flex: 1,
    color: theme?.colors?.text,
  },
  scroll: { paddingBottom: 8 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: theme?.colors?.textSubtle,
    marginBottom: 6,
  },
  editHint: {
    fontSize: 11,
    fontWeight: "500",
    color: theme?.colors?.textFine,
    letterSpacing: 0,
  },
  originalBox: {
    backgroundColor: theme?.colors?.mainBackground,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    padding: 12,
  },
  originalText: {
    fontSize: 14,
    color: theme?.colors?.textSubtle,
    fontStyle: "italic",
    lineHeight: 20,
  },
  suggestionInput: {
    backgroundColor: theme?.colors?.mainBackground,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: theme?.colors?.primary,
    padding: 12,
    fontSize: 15,
    color: theme?.colors?.text,
    minHeight: 110,
    lineHeight: 21,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.55)",
    borderRadius: 10,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    backgroundColor: theme?.colors?.cardBackground,
  },
  btnGhostTxt: {
    fontSize: 13.5,
    fontWeight: "700",
    color: theme?.colors?.primary,
  },
  btnPrimary: {
    flex: 1,
    backgroundColor: theme?.colors?.primary,
  },
  btnPrimaryTxt: { fontSize: 14, fontWeight: "700", color: "#fff" },
  btnDisabled: { opacity: 0.6 },
});
