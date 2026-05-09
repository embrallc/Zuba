import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  Alert,
  Dimensions,
  Image,
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
import { deleteDetail, updateDetail } from "../db/inspectionForm";
import { logError } from "../db/logs";

// Skia markup drawing is implemented in components/PhotoEditSkia.jsx.
// Swap that file's contents in here once a development build is available.

const SAVE_STATES = { idle: null, saving: "Saving…", saved: "Saved ✓" };
const { width: SCREEN_WIDTH } = Dimensions.get("window");
const IMG_HEIGHT = Math.round(SCREEN_WIDTH * 0.75);

export default function PhotoEditScreen() {
  const router = useRouter();
  const { detailSk, uri, initialNote, initialMarkup } = useLocalSearchParams();

  const [note, setNote] = useState(initialNote ?? "");
  const [saveState, setSaveState] = useState("idle");

  const saveTimers = useRef({});

  function flashSave(asyncFn) {
    setSaveState("saving");
    asyncFn()
      .then(() => {
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1800);
      })
      .catch((e) => {
        logError(e, "PhotoEditScreen.flashSave");
        setSaveState("idle");
      });
  }

  function scheduleAutoSave(key, asyncFn, delay = 600) {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => flashSave(asyncFn), delay);
  }

  function handleNoteChange(value) {
    setNote(value);
    // Preserve any existing markup — don't overwrite it with null
    scheduleAutoSave("note", () =>
      updateDetail(detailSk, {
        pictureNote: value,
        pictureMarkup: initialMarkup || null,
      }),
    );
  }

  async function handleDelete() {
    Alert.alert("Delete Photo", "Remove this photo from the section?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDetail(detailSk);
            router.back();
          } catch (e) {
            logError(e, `PhotoEditScreen.handleDelete sk=${detailSk}`);
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme.layout.iconSize.l}
            color={theme.colors.icon}
          />
        </TouchableOpacity>
        <Text
          style={[
            styles.saveIndicator,
            saveState === "saved" && styles.saveIndicatorDone,
          ]}
        >
          {SAVE_STATES[saveState] ?? ""}
        </Text>
        <TouchableOpacity
          onPress={handleDelete}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={theme.layout.iconSize.l}
            color={theme.colors.textSubtle}
          />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Image source={{ uri }} style={styles.image} resizeMode="cover" />

          {/* Markup placeholder — enabled once dev build is available */}
          <View style={styles.markupPlaceholder}>
            <MaterialCommunityIcons
              name="draw"
              size={16}
              color={theme.colors.textFine}
            />
            <Text style={styles.markupPlaceholderText}>
              Markup available in full build
            </Text>
          </View>

          <Text style={styles.overline}>NOTE</Text>
          <TextInput
            style={styles.noteInput}
            value={note}
            onChangeText={handleNoteChange}
            placeholder="Describe what this photo shows…"
            placeholderTextColor={theme.colors.textFine}
            multiline
            textAlignVertical="top"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.mainBackground },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    backgroundColor: theme.colors.cardBackground,
    borderBottomWidth: theme.layout.borderWidth.thin,
    borderBottomColor: theme.colors.input,
    ...theme.shadows.light,
  },
  saveIndicator: { ...theme.typography.caption, color: theme.colors.textFine },
  saveIndicatorDone: { color: "#16A34A" },
  content: { paddingBottom: theme.spacing.xxl },
  image: {
    width: SCREEN_WIDTH,
    height: IMG_HEIGHT,
    backgroundColor: theme.colors.input,
  },
  markupPlaceholder: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    margin: theme.spacing.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    borderRadius: theme.layout.borderRadius.s,
    alignSelf: "flex-start",
  },
  markupPlaceholderText: {
    ...theme.typography.label,
    color: theme.colors.textFine,
  },
  overline: {
    ...theme.typography.overline,
    marginHorizontal: theme.spacing.m,
    marginBottom: theme.spacing.s,
  },
  noteInput: {
    ...theme.typography.body,
    color: theme.colors.text,
    marginHorizontal: theme.spacing.m,
    minHeight: 120,
    textAlignVertical: "top",
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
  },
});
