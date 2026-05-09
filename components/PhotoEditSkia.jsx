/**
 * Full Skia markup implementation of the photo edit screen.
 * Requires a development build — NOT usable in Expo Go.
 *
 * To re-enable:
 *   1. Complete a development build (`npx expo run:ios` / `npx expo run:android`)
 *   2. Copy this file's contents back into app/photoedit.jsx
 *   3. The metro.config.js resolver redirect for @shopify/react-native-skia is
 *      already in place and will handle the const-enum bundling issue.
 */

import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  Canvas,
  Path,
  Skia,
} from "@shopify/react-native-skia";
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
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  runOnJS,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { deleteDetail, updateDetail } from "../db/inspectionForm";
import { logError } from "../db/logs";

const SAVE_STATES = { idle: null, saving: "Saving…", saved: "Saved ✓" };
const { width: SCREEN_WIDTH } = Dimensions.get("window");
const IMG_HEIGHT = Math.round(SCREEN_WIDTH * 0.75);

const COLORS = [
  { key: "red",    hex: "#FF3B30" },
  { key: "orange", hex: "#FF9500" },
  { key: "yellow", hex: "#FFD60A" },
  { key: "green",  hex: "#34C759" },
  { key: "blue",   hex: "#007AFF" },
  { key: "white",  hex: "#FFFFFF" },
  { key: "black",  hex: "#1C1C1E" },
];

const SIZES = [
  { key: "thin",  value: 3,  label: "Thin" },
  { key: "med",   value: 6,  label: "Med" },
  { key: "thick", value: 12, label: "Thick" },
];

export default function PhotoEditScreen() {
  const router = useRouter();
  const { detailSk, uri, initialNote, initialMarkup } = useLocalSearchParams();

  const [note, setNote] = useState(initialNote ?? "");
  const [saveState, setSaveState] = useState("idle");
  const [drawMode, setDrawMode] = useState(false);
  const [selectedColor, setSelectedColor] = useState("#FF3B30");
  const [selectedSize, setSelectedSize] = useState(6);

  const [strokes, setStrokes] = useState(() => {
    try {
      const parsed = JSON.parse(initialMarkup || "null");
      return parsed?.strokes ?? [];
    } catch {
      return [];
    }
  });
  const strokesRef = useRef(strokes);

  const currentSvg = useSharedValue("");
  const currentColor = useSharedValue(selectedColor);
  const currentWidth = useSharedValue(selectedSize);

  const animatedPath = useDerivedValue(() => {
    if (!currentSvg.value) return Skia.Path.Make();
    return Skia.Path.MakeFromSVGString(currentSvg.value) ?? Skia.Path.Make();
  });

  const saveTimers = useRef({});

  function flashSave(asyncFn) {
    setSaveState("saving");
    asyncFn()
      .then(() => {
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1800);
      })
      .catch((e) => {
        logError(e, "PhotoEditSkia.flashSave");
        setSaveState("idle");
      });
  }

  function scheduleAutoSave(key, asyncFn, delay = 600) {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => flashSave(asyncFn), delay);
  }

  function persistDetail(noteVal, strokeArr) {
    const markup = strokeArr.length
      ? JSON.stringify({ strokes: strokeArr })
      : null;
    return updateDetail(detailSk, { pictureNote: noteVal, pictureMarkup: markup });
  }

  function handleNoteChange(value) {
    setNote(value);
    scheduleAutoSave("detail", () => persistDetail(value, strokesRef.current));
  }

  function commitStroke(svg, color, width) {
    if (!svg) return;
    const next = [...strokesRef.current, { svg, color, width }];
    strokesRef.current = next;
    setStrokes(next);
    scheduleAutoSave("detail", () => persistDetail(note, next));
  }

  function handleUndo() {
    if (!strokesRef.current.length) return;
    const next = strokesRef.current.slice(0, -1);
    strokesRef.current = next;
    setStrokes(next);
    scheduleAutoSave("detail", () => persistDetail(note, next));
  }

  function handleClearAll() {
    Alert.alert("Clear markup", "Remove all drawings from this photo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          strokesRef.current = [];
          setStrokes([]);
          scheduleAutoSave("detail", () => persistDetail(note, []));
        },
      },
    ]);
  }

  const drawGesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      currentSvg.value = `M${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
    })
    .onUpdate((e) => {
      currentSvg.value =
        currentSvg.value + ` L${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
    })
    .onEnd(() => {
      const svg = currentSvg.value;
      const color = currentColor.value;
      const width = currentWidth.value;
      currentSvg.value = "";
      runOnJS(commitStroke)(svg, color, width);
    });

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
            logError(e, `PhotoEditSkia.handleDelete sk=${detailSk}`);
          }
        },
      },
    ]);
  }

  function PhotoCanvas({ interactive }) {
    return (
      <View style={styles.photoContainer}>
        <Image source={{ uri }} style={styles.image} resizeMode="cover" />
        {interactive ? (
          <GestureDetector gesture={drawGesture}>
            <Canvas style={styles.canvas}>
              <CompletedStrokes strokes={strokes} />
              <Path
                path={animatedPath}
                color={selectedColor}
                strokeWidth={selectedSize}
                style="stroke"
                strokeJoin="round"
                strokeCap="round"
              />
            </Canvas>
          </GestureDetector>
        ) : strokes.length > 0 ? (
          <View pointerEvents="none" style={styles.canvas}>
            <Canvas style={styles.canvas}>
              <CompletedStrokes strokes={strokes} />
            </Canvas>
          </View>
        ) : null}
      </View>
    );
  }

  const hasMarkup = strokes.length > 0;

  if (drawMode) {
    return (
      <SafeAreaView style={styles.safeDraw} edges={["top", "bottom"]}>
        <View style={styles.navbar}>
          <TouchableOpacity
            onPress={handleUndo}
            disabled={!strokes.length}
            hitSlop={theme.layout.hitSlop.medium}
          >
            <MaterialCommunityIcons
              name="undo"
              size={theme.layout.iconSize.l}
              color={strokes.length ? theme.colors.icon : theme.colors.textFine}
            />
          </TouchableOpacity>
          <Text style={styles.navTitle}>Draw</Text>
          <TouchableOpacity
            onPress={() => setDrawMode(false)}
            hitSlop={theme.layout.hitSlop.medium}
          >
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        <PhotoCanvas interactive />

        <View style={styles.drawToolbar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.colorRow}
          >
            {COLORS.map((c) => {
              const active = selectedColor === c.hex;
              return (
                <TouchableOpacity
                  key={c.key}
                  onPress={() => {
                    setSelectedColor(c.hex);
                    currentColor.value = c.hex;
                  }}
                  style={[
                    styles.swatch,
                    { backgroundColor: c.hex },
                    active && styles.swatchActive,
                    c.key === "white" && styles.swatchWhiteBorder,
                  ]}
                />
              );
            })}
          </ScrollView>

          <View style={styles.sizeRow}>
            {SIZES.map((s) => {
              const active = selectedSize === s.value;
              return (
                <TouchableOpacity
                  key={s.key}
                  onPress={() => {
                    setSelectedSize(s.value);
                    currentWidth.value = s.value;
                  }}
                  style={[styles.sizeBtn, active && styles.sizeBtnActive]}
                >
                  <View
                    style={[
                      styles.sizeBubble,
                      {
                        width: s.value * 2.5,
                        height: s.value * 2.5,
                        backgroundColor: active
                          ? selectedColor
                          : theme.colors.textSubtle,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.sizeLabel,
                      active && { color: theme.colors.primary },
                    ]}
                  >
                    {s.label}
                  </Text>
                </TouchableOpacity>
              );
            })}

            {hasMarkup && (
              <TouchableOpacity
                onPress={handleClearAll}
                style={styles.clearBtn}
                hitSlop={theme.layout.hitSlop.medium}
              >
                <MaterialCommunityIcons
                  name="delete-sweep-outline"
                  size={22}
                  color={theme.colors.textSubtle}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </SafeAreaView>
    );
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
          <PhotoCanvas interactive={false} />

          <TouchableOpacity
            style={[styles.markupBtn, hasMarkup && styles.markupBtnFilled]}
            onPress={() => setDrawMode(true)}
            activeOpacity={0.75}
          >
            <MaterialCommunityIcons
              name="draw"
              size={16}
              color={hasMarkup ? "#fff" : theme.colors.primary}
            />
            <Text
              style={[styles.markupBtnText, hasMarkup && { color: "#fff" }]}
            >
              {hasMarkup ? "Edit Markup" : "Add Markup"}
            </Text>
          </TouchableOpacity>

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

function CompletedStrokes({ strokes }) {
  return strokes.map((stroke, i) => {
    const path = Skia.Path.MakeFromSVGString(stroke.svg);
    if (!path) return null;
    return (
      <Path
        key={i}
        path={path}
        color={stroke.color}
        strokeWidth={stroke.width}
        style="stroke"
        strokeJoin="round"
        strokeCap="round"
      />
    );
  });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.mainBackground },
  safeDraw: { flex: 1, backgroundColor: "#000" },
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
  navTitle: { ...theme.typography.h4 },
  doneText: { ...theme.typography.bodyBold, color: theme.colors.primary },
  saveIndicator: { ...theme.typography.caption, color: theme.colors.textFine },
  saveIndicatorDone: { color: "#4CAF50" },
  content: { paddingBottom: theme.spacing.xxl },
  photoContainer: { width: SCREEN_WIDTH, height: IMG_HEIGHT },
  image: {
    width: SCREEN_WIDTH,
    height: IMG_HEIGHT,
    backgroundColor: theme.colors.input,
  },
  canvas: {
    position: "absolute",
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: IMG_HEIGHT,
  },
  markupBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    margin: theme.spacing.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.s,
    alignSelf: "flex-start",
  },
  markupBtnFilled: { backgroundColor: theme.colors.primary },
  markupBtnText: { ...theme.typography.label, color: theme.colors.primary },
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
  drawToolbar: {
    backgroundColor: theme.colors.cardBackground,
    borderTopWidth: theme.layout.borderWidth.thin,
    borderTopColor: theme.colors.input,
    paddingTop: theme.spacing.s,
    paddingBottom: theme.spacing.m,
    gap: theme.spacing.s,
  },
  colorRow: {
    flexDirection: "row",
    gap: theme.spacing.s,
    paddingHorizontal: theme.spacing.m,
    alignItems: "center",
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchActive: {
    borderColor: theme.colors.primary,
    transform: [{ scale: 1.25 }],
  },
  swatchWhiteBorder: { borderColor: theme.colors.input },
  sizeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.m,
    gap: theme.spacing.l,
  },
  sizeBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing.s,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.s,
  },
  sizeBtnActive: { backgroundColor: theme.colors.input },
  sizeBubble: { borderRadius: 999 },
  sizeLabel: { ...theme.typography.caption, color: theme.colors.textSubtle },
  clearBtn: { marginLeft: "auto" },
});
