import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import KeyboardToolbar from "../components/KeyboardToolbar";
import {
  deleteDetail,
  getDetailsByDescription,
  updateDetail,
} from "../db/inspectionForm";
import { logError } from "../db/logs";
import { useVoiceField } from "../hooks/useVoiceField";
import { resolvePhotoUri } from "../utils/inspectionPhotos";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const PHOTO_HEIGHT = 200;
const TOOLBAR_HEIGHT = 56;

export default function PhotoNoteModal() {
  const router = useRouter();
  const { sectionSk, initialDetailSk } = useLocalSearchParams();

  const [details, setDetails] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [notes, setNotes] = useState({});
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const listRef = useRef(null);
  const saveTimers = useRef({});

  useEffect(() => {
    loadDetails();
  }, []);

  // Clear any in-flight debounced note saves when the modal closes. Without
  // this, a pending setTimeout fires against unmounted state and may write a
  // stale markup snapshot captured in the closure.
  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach((t) => clearTimeout(t));
      saveTimers.current = {};
    };
  }, []);

  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(show, (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const onHide = Keyboard.addListener(hide, () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  async function loadDetails() {
    try {
      const rows = await getDetailsByDescription(sectionSk);
      const detailList = await Promise.all(
        rows.map(async (d) => ({
          sk: d.InspectionDetailSk,
          uri: await resolvePhotoUri({
            localUri: d.LocalPictureURI,
            cloudUri: d.CloudPictureURI,
          }),
          note: d.PictureNote ?? "",
          markup: d.PictureMarkup ?? null,
        })),
      );
      setDetails(detailList);

      const notesMap = {};
      detailList.forEach((d) => {
        notesMap[d.sk] = d.note;
      });
      setNotes(notesMap);

      const idx = detailList.findIndex((d) => d.sk === initialDetailSk);
      const startIndex = idx >= 0 ? idx : 0;
      setCurrentIndex(startIndex);
      if (startIndex > 0) {
        setTimeout(() => {
          listRef.current?.scrollToIndex({ index: startIndex, animated: false });
        }, 50);
      }
    } catch (e) {
      logError(e, "PhotoNoteModal.loadDetails");
    }
  }

  function handleNoteChange(sk, value) {
    setNotes((prev) => ({ ...prev, [sk]: value }));
    const markup = details.find((d) => d.sk === sk)?.markup ?? null;
    clearTimeout(saveTimers.current[sk]);
    saveTimers.current[sk] = setTimeout(async () => {
      try {
        await updateDetail(sk, { pictureNote: value, pictureMarkup: markup });
      } catch (e) {
        logError(e, "PhotoNoteModal.handleNoteChange");
      }
    }, 600);
  }

  async function handleDelete() {
    const sk = details[currentIndex]?.sk;
    if (!sk) return;
    Alert.alert("Delete Photo", "Remove this photo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDetail(sk);
            const next = details.filter((d) => d.sk !== sk);
            if (next.length === 0) {
              router.back();
              return;
            }
            setDetails(next);
            const nextIndex = Math.min(currentIndex, next.length - 1);
            setCurrentIndex(nextIndex);
            setTimeout(() => {
              listRef.current?.scrollToIndex({
                index: nextIndex,
                animated: false,
              });
            }, 50);
          } catch (e) {
            logError(e, "PhotoNoteModal.handleDelete");
          }
        },
      },
    ]);
  }

  const dismiss = useCallback(() => router.back(), [router]);

  // RNGH Pan on the handle only — avoids any conflict with the FlatList
  const swipeDownGesture = Gesture.Pan()
    .minDistance(10)
    .onEnd((e) => {
      if (e.translationY > 60) runOnJS(dismiss)();
    });

  const currentDetail = details[currentIndex];
  const currentNote = currentDetail ? (notes[currentDetail.sk] ?? "") : "";

  // Voice dictation: the inspectionform owns the recognition session (its
  // VoiceFab stays mounted while this modal is on top), so we just register
  // the currently-displayed note as the target field.
  const noteVoice = useVoiceField(currentNote, (v) =>
    currentDetail && handleNoteChange(currentDetail.sk, v),
  );

  return (
    <View style={styles.root}>
      {/* Backdrop — tap outside panel to dismiss */}
      <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />

      {/* Panel slides up when keyboard appears via marginBottom */}
      <View
        style={[
          styles.panel,
          {
            marginBottom: keyboardHeight,
            // Extra padding so the note input clears the floating KeyboardToolbar
            paddingBottom: keyboardVisible ? TOOLBAR_HEIGHT : 0,
          },
        ]}
      >
        {/* Drag handle — RNGH swipe down */}
        <GestureDetector gesture={swipeDownGesture}>
          <View style={styles.handleArea}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        {/* Horizontal photo strip — swipe left/right to navigate */}
        {details.length > 0 && (
          <FlatList
            ref={listRef}
            data={details}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.sk}
            getItemLayout={(_, index) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * index,
              index,
            })}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(
                e.nativeEvent.contentOffset.x / SCREEN_WIDTH,
              );
              setCurrentIndex(idx);
            }}
            renderItem={({ item }) => <PhotoSlide uri={item.uri} />}
          />
        )}

        {/* Page count + delete */}
        <View style={styles.controlsRow}>
          <Text style={styles.pageCount}>
            {details.length > 1
              ? `${currentIndex + 1} / ${details.length}`
              : ""}
          </Text>
          <TouchableOpacity
            onPress={handleDelete}
            hitSlop={theme.layout.hitSlop.medium}
          >
            <MaterialCommunityIcons
              name="trash-can-outline"
              size={20}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>

        {/* Note input */}
        <Text style={styles.overline}>NOTE</Text>
        <TextInput
          style={styles.noteInput}
          value={currentNote}
          onChangeText={(v) =>
            currentDetail && handleNoteChange(currentDetail.sk, v)
          }
          onFocus={noteVoice.onFocus}
          placeholder="Describe what this photo shows…"
          placeholderTextColor={theme.colors.textFine}
          multiline
          textAlignVertical="top"
        />

        {/* Safe area padding only when keyboard is hidden */}
        {!keyboardVisible && <SafeAreaView edges={["bottom"]} />}
      </View>

      {/* Keyboard toolbar floats above keyboard, outside panel so it positions
          relative to the full-screen root view */}
      <KeyboardToolbar
        visible={keyboardVisible}
        keyboardHeight={keyboardHeight}
        canGoPrev={false}
        canGoNext={false}
      />
    </View>
  );
}

function PhotoSlide({ uri }) {
  const [loading, setLoading] = useState(!!uri);
  return (
    <View style={styles.photo}>
      {!!uri && (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onLoad={() => setLoading(false)}
          onError={() => setLoading(false)}
        />
      )}
      {loading && (
        <View style={[StyleSheet.absoluteFillObject, styles.photoLoading]}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  panel: {
    backgroundColor: theme.colors.cardBackground,
    borderTopLeftRadius: theme.layout.borderRadius.xl,
    borderTopRightRadius: theme.layout.borderRadius.xl,
    ...theme.shadows.dark,
  },
  handleArea: {
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.input,
  },
  photo: {
    width: SCREEN_WIDTH,
    height: PHOTO_HEIGHT,
    backgroundColor: theme.colors.input,
  },
  photoLoading: {
    alignItems: "center",
    justifyContent: "center",
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
  },
  pageCount: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
  },
  overline: {
    ...theme.typography.overline,
    marginHorizontal: theme.spacing.m,
    marginBottom: theme.spacing.xs,
  },
  noteInput: {
    ...theme.typography.body,
    color: theme.colors.text,
    marginHorizontal: theme.spacing.m,
    marginBottom: theme.spacing.m,
    minHeight: 100,
    textAlignVertical: "top",
    backgroundColor: theme.colors.mainBackground,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
  },
});
