import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { AnimatePresence, MotiView } from "moti";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import DraggableFlatList, {
  ScaleDecorator,
} from "react-native-draggable-flatlist";
import { SafeAreaView } from "react-native-safe-area-context";
import KeyboardToolbar from "../components/KeyboardToolbar";
import {
  deleteDescription,
  deleteDetail,
  getDescriptionsByInspection,
  getDetailsByDescription,
  insertDescription,
  insertDetail,
  updateDescription,
  updateSectionNotes,
  updateSectionPositions,
  updateSeverityLevel,
} from "../db/inspectionForm";
import { updateInspection } from "../db/inspections";
import { logError } from "../db/logs";
import { getSectionTemplates } from "../db/sectionTemplates";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const PHOTOS_DIR = `${FileSystem.documentDirectory}inspection_photos/`;

const SEVERITY = [
  { key: "ok",       label: "OK",       color: "#16A34A", bg: "#DCFCE7" },
  { key: "low",      label: "Low",      color: "#CA8A04", bg: "#FEF3C7" },
  { key: "medium",   label: "Medium",   color: "#EA580C", bg: "#FFEDD5" },
  { key: "critical", label: "Critical", color: "#DC2626", bg: "#FEE2E2" },
];

export default function InspectionFormScreen() {
  const router = useRouter();
  const { inspectionSk } = useLocalSearchParams();
  const userSk = useSettingsStore((s) => s.userSk);

  const inspection = useInspectionStore((s) => s.getById(inspectionSk));
  const updateInStore = useInspectionStore((s) => s.update);

  const [summary, setSummary] = useState(inspection?.Summary ?? "");
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [isDragging, setIsDragging] = useState(false);

  // ── Keyboard ───────────────────────────────────────────────────────────
  const inputRefs = useRef({});
  const [focusedField, setFocusedField] = useState(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

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

  // ── Field order for toolbar prev/next ─────────────────────────────────
  const fieldOrder = useMemo(() => {
    const fields = ["summary"];
    sections.forEach((sec) => {
      fields.push(`desc_${sec.sk}`);
      fields.push(`notes_${sec.sk}`);
    });
    return fields;
  }, [sections]);

  const currentIndex = fieldOrder.indexOf(focusedField);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < fieldOrder.length - 1;

  function focusPrev() {
    if (canGoPrev) inputRefs.current[fieldOrder[currentIndex - 1]]?.focus();
  }
  function focusNext() {
    if (canGoNext) inputRefs.current[fieldOrder[currentIndex + 1]]?.focus();
  }

  // ── Load from DB ───────────────────────────────────────────────────────
  const initialLoadDone = useRef(false);

  const loadSections = useCallback(async () => {
    if (!inspectionSk) return;
    try {
      let descs = await getDescriptionsByInspection(inspectionSk);

      // Auto-populate from section templates on the very first load of a blank form
      if (descs.length === 0 && !initialLoadDone.current && userSk) {
        const templates = await getSectionTemplates(userSk);
        if (templates.length > 0) {
          for (const [i, tmpl] of templates.entries()) {
            await insertDescription(inspectionSk, tmpl.Name, i);
          }
          descs = await getDescriptionsByInspection(inspectionSk);
        }
      }

      const withDetails = await Promise.all(
        descs.map(async (d) => {
          const rawDetails = await getDetailsByDescription(
            d.InspectionDescriptionSk,
          );
          return {
            sk: d.InspectionDescriptionSk,
            description: d.Description ?? "",
            notes: d.Notes ?? "",
            severity: d.SeverityLevel ?? null,
            details: rawDetails.map((det) => ({
              sk: det.InspectionDetailSk,
              uri: det.PictureURI,
              note: det.PictureNote ?? "",
              markup: det.PictureMarkup ?? null,
            })),
          };
        }),
      );
      setSections(withDetails);
    } catch (e) {
      logError(e, `InspectionFormScreen.loadSections sk=${inspectionSk}`);
    }
  }, [inspectionSk, userSk]);

  useEffect(() => {
    loadSections().finally(() => {
      setLoading(false);
      initialLoadDone.current = true;
    });
  }, [loadSections]);

  useFocusEffect(
    useCallback(() => {
      if (initialLoadDone.current) {
        loadSections();
      }
    }, [loadSections]),
  );

  // ── Auto-save helpers ──────────────────────────────────────────────────
  const saveTimers = useRef({});

  function flashSave(asyncFn) {
    setSaveState("saving");
    asyncFn()
      .then(() => {
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1800);
      })
      .catch((e) => {
        logError(e, "InspectionFormScreen.flashSave");
        setSaveState("idle");
      });
  }

  function scheduleAutoSave(key, asyncFn, delay = 800) {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => flashSave(asyncFn), delay);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  function handleSummaryChange(value) {
    setSummary(value);
    scheduleAutoSave("summary", async () => {
      const updated = await updateInspection(inspectionSk, {
        ...inspection,
        Summary: value,
      });
      updateInStore({ ...inspection, ...updated });
    });
  }

  // ── Position sync ──────────────────────────────────────────────────────
  async function syncPositions(secs) {
    try {
      await updateSectionPositions(
        secs.map((s, i) => ({ sk: s.sk, position: i })),
      );
    } catch (e) {
      logError(e, "InspectionFormScreen.syncPositions");
    }
  }

  // ── Sections ───────────────────────────────────────────────────────────
  async function handleAddSection() {
    try {
      const newDesc = await insertDescription(
        inspectionSk,
        "",
        sections.length,
      );
      const updated = [
        ...sections,
        {
          sk: newDesc.InspectionDescriptionSk,
          description: "",
          notes: "",
          severity: null,
          details: [],
        },
      ];
      setSections(updated);
    } catch (e) {
      logError(e, "InspectionFormScreen.handleAddSection");
    }
  }

  async function handleInsertAt(index) {
    try {
      const newDesc = await insertDescription(inspectionSk, "", index);
      const newSection = {
        sk: newDesc.InspectionDescriptionSk,
        description: "",
        notes: "",
        severity: null,
        details: [],
      };
      const updated = [
        ...sections.slice(0, index),
        newSection,
        ...sections.slice(index),
      ];
      setSections(updated);
      await syncPositions(updated);
    } catch (e) {
      logError(e, `InspectionFormScreen.handleInsertAt index=${index}`);
    }
  }

  async function handleDragEnd({ data }) {
    setIsDragging(false);
    setSections(data);
    await syncPositions(data);
  }

  async function handleDeleteSection(sk) {
    Alert.alert(
      "Delete Section",
      "This will remove the section and all its photos. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteDescription(sk);
              const updated = sections.filter((s) => s.sk !== sk);
              setSections(updated);
              await syncPositions(updated);
            } catch (e) {
              logError(e, `InspectionFormScreen.handleDeleteSection sk=${sk}`);
            }
          },
        },
      ],
    );
  }

  function handleDescriptionChange(sk, value) {
    setSections((prev) =>
      prev.map((s) => (s.sk === sk ? { ...s, description: value } : s)),
    );
    scheduleAutoSave(`desc_${sk}`, () => updateDescription(sk, value));
  }

  function handleNotesChange(sk, value) {
    setSections((prev) =>
      prev.map((s) => (s.sk === sk ? { ...s, notes: value } : s)),
    );
    scheduleAutoSave(`notes_${sk}`, () => updateSectionNotes(sk, value));
  }

  function handleSeverityChange(sk, level) {
    setSections((prev) =>
      prev.map((s) => (s.sk === sk ? { ...s, severity: level } : s)),
    );
    flashSave(() => updateSeverityLevel(sk, level));
  }

  // ── Photo helpers ──────────────────────────────────────────────────────
  async function appendPhoto(sectionSk, sourceUri) {
    try {
      await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
      const dest = `${PHOTOS_DIR}${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.jpg`;
      await FileSystem.copyAsync({ from: sourceUri, to: dest });
      const newDetail = await insertDetail(sectionSk, { pictureURI: dest });
      setSections((prev) =>
        prev.map((s) =>
          s.sk === sectionSk
            ? {
                ...s,
                details: [
                  ...s.details,
                  {
                    sk: newDetail.InspectionDetailSk,
                    uri: dest,
                    note: "",
                    markup: null,
                  },
                ],
              }
            : s,
        ),
      );
    } catch (e) {
      logError(e, `InspectionFormScreen.appendPhoto sectionSk=${sectionSk}`);
    }
  }

  async function pickFromLibrary(sectionSk) {
    try {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Allow photo library access to upload pictures.",
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsMultipleSelection: true,
      });
      if (result.canceled || !result.assets?.length) return;
      for (const asset of result.assets) {
        await appendPhoto(sectionSk, asset.uri);
      }
    } catch (e) {
      logError(
        e,
        `InspectionFormScreen.pickFromLibrary sectionSk=${sectionSk}`,
      );
    }
  }

  function handleCameraPress(sectionSk) {
    router.push({ pathname: "/camera", params: { sectionSk } });
  }

  function handleOpenPhoto(detail, sectionSk) {
    router.push({
      pathname: "/photonote",
      params: { sectionSk, initialDetailSk: detail.sk },
    });
  }

  async function handleDeletePhoto(detailSk, sectionSk) {
    try {
      await deleteDetail(detailSk);
      setSections((prev) =>
        prev.map((s) =>
          s.sk === sectionSk
            ? { ...s, details: s.details.filter((d) => d.sk !== detailSk) }
            : s,
        ),
      );
    } catch (e) {
      logError(e, `InspectionFormScreen.handleDeletePhoto sk=${detailSk}`);
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────
  const title = inspection?.FullName
    ? `${inspection.FullName} — ${dayjs(inspection.ScheduledAt).format("MMM D")}`
    : "Inspection Form";

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityIndicator
          style={{ flex: 1 }}
          size="large"
          color={theme.colors.primary}
        />
      </SafeAreaView>
    );
  }

  function renderSectionItem({ item, index, drag, isActive }) {
    return (
      <ScaleDecorator activeScale={0.97}>
        <SectionCard
          section={item}
          index={index}
          inputRefs={inputRefs}
          setFocusedField={setFocusedField}
          onDescriptionChange={handleDescriptionChange}
          onNotesChange={handleNotesChange}
          onSeverityChange={handleSeverityChange}
          onDeleteSection={handleDeleteSection}
          onCameraPress={handleCameraPress}
          onUploadPhoto={pickFromLibrary}
          onOpenPhoto={handleOpenPhoto}
          onDeletePhoto={handleDeletePhoto}
          drag={drag}
          isActive={isActive}
        />
      </ScaleDecorator>
    );
  }

  function renderSeparator({ leadingItem }) {
    if (isDragging) return null;
    const leadingIndex = sections.findIndex((s) => s.sk === leadingItem.sk);
    return (
      <InsertSeparator onPress={() => handleInsertAt(leadingIndex + 1)} />
    );
  }

  const summaryHeader = (
    <View style={styles.summaryHeader}>
      <Text style={styles.overline}>SUMMARY</Text>
      <TextInput
        ref={(r) => {
          inputRefs.current["summary"] = r;
        }}
        onFocus={() => setFocusedField("summary")}
        style={[styles.input, styles.textArea]}
        value={summary}
        onChangeText={handleSummaryChange}
        placeholder="Overall findings and notes…"
        placeholderTextColor={theme.colors.textFine}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
      />
    </View>
  );

  const addSectionFooter = (
    <View style={styles.footerContent}>
      <TouchableOpacity style={styles.addSectionBtn} onPress={handleAddSection}>
        <MaterialCommunityIcons
          name="plus-circle-outline"
          size={20}
          color={theme.colors.primary}
        />
        <Text style={styles.addSectionText}>Add Section</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Navbar */}
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="close"
            size={theme.layout.iconSize.l}
            color={theme.colors.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle} numberOfLines={1}>
          {title}
        </Text>

        {/* Animated save state indicator */}
        <View style={styles.saveIndicatorContainer}>
          <AnimatePresence>
            {saveState === "saving" && (
              <MotiView
                key="saving"
                from={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ type: "spring", damping: 15, stiffness: 200 }}
                style={styles.saveIndicatorInner}
              >
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </MotiView>
            )}
            {saveState === "saved" && (
              <MotiView
                key="saved"
                from={{ opacity: 0, scale: 0.6, translateY: 5 }}
                animate={{ opacity: 1, scale: 1, translateY: 0 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ type: "spring", damping: 12, stiffness: 220 }}
                style={styles.saveIndicatorInner}
              >
                <MaterialCommunityIcons
                  name="check-circle"
                  size={20}
                  color={theme.colors.success}
                />
              </MotiView>
            )}
          </AnimatePresence>
        </View>
      </View>

      <DraggableFlatList
        data={sections}
        keyExtractor={(item) => item.sk}
        onDragBegin={() => setIsDragging(true)}
        onDragEnd={handleDragEnd}
        renderItem={renderSectionItem}
        ItemSeparatorComponent={renderSeparator}
        ListHeaderComponent={summaryHeader}
        ListFooterComponent={addSectionFooter}
        contentContainerStyle={
          keyboardVisible ? { paddingBottom: keyboardHeight + 56 } : undefined
        }
        keyboardShouldPersistTaps="handled"
      />

      <KeyboardToolbar
        visible={keyboardVisible}
        keyboardHeight={keyboardHeight}
        canGoPrev={canGoPrev}
        canGoNext={canGoNext}
        onPrev={focusPrev}
        onNext={focusNext}
      />
    </SafeAreaView>
  );
}

// ── InsertSeparator ────────────────────────────────────────────────────────
function InsertSeparator({ onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.separator}
      activeOpacity={0.7}
    >
      <View style={styles.separatorLine} />
      <View style={styles.separatorCircle}>
        <MaterialCommunityIcons
          name="plus"
          size={13}
          color={theme.colors.primary}
        />
      </View>
      <View style={styles.separatorLine} />
    </TouchableOpacity>
  );
}

// ── SectionCard ────────────────────────────────────────────────────────────
function SectionCard({
  section,
  index,
  inputRefs,
  setFocusedField,
  onDescriptionChange,
  onNotesChange,
  onSeverityChange,
  onDeleteSection,
  onCameraPress,
  onUploadPhoto,
  onOpenPhoto,
  onDeletePhoto,
  drag,
  isActive,
}) {
  const severityColor = SEVERITY.find((s) => s.key === section.severity)?.color;

  return (
    <View
      style={[
        styles.section,
        isActive && styles.sectionActive,
        { borderLeftWidth: 4, borderLeftColor: severityColor ?? theme.colors.input },
      ]}
    >
      <View style={styles.sectionHeader}>
        <TouchableOpacity
          onLongPress={drag}
          delayLongPress={150}
          style={styles.dragHandle}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="drag-horizontal-variant"
            size={20}
            color={theme.colors.textFine}
          />
        </TouchableOpacity>
        <TextInput
          ref={(r) => {
            inputRefs.current[`desc_${section.sk}`] = r;
          }}
          onFocus={() => setFocusedField(`desc_${section.sk}`)}
          style={styles.sectionNameInput}
          value={section.description}
          onChangeText={(v) => onDescriptionChange(section.sk, v)}
          placeholder="Section name…"
          placeholderTextColor={theme.colors.textFine}
          returnKeyType="done"
        />
        <TouchableOpacity
          onPress={() => onDeleteSection(section.sk)}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={theme.layout.iconSize.m}
            color={theme.colors.textSubtle}
          />
        </TouchableOpacity>
      </View>

      <SeverityPicker
        value={section.severity}
        onChange={(level) => onSeverityChange(section.sk, level)}
      />

      <TextInput
        ref={(r) => {
          inputRefs.current[`notes_${section.sk}`] = r;
        }}
        onFocus={() => setFocusedField(`notes_${section.sk}`)}
        style={[styles.input, styles.textArea]}
        value={section.notes}
        onChangeText={(v) => onNotesChange(section.sk, v)}
        placeholder="Describe what was found in this section…"
        placeholderTextColor={theme.colors.textFine}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.thumbnailRow}
      >
        {section.details.map((detail) => (
          <View key={detail.sk} style={styles.thumbnailContainer}>
            <TouchableOpacity
              onPress={() => onOpenPhoto(detail, section.sk)}
              activeOpacity={0.8}
              style={styles.thumbnailWrapper}
            >
              <Image
                source={{ uri: detail.uri }}
                style={styles.thumbnail}
                resizeMode="cover"
              />
              {!!detail.note && <View style={styles.thumbnailDot} />}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.thumbnailDelete}
              onPress={() => onDeletePhoto(detail.sk, section.sk)}
              hitSlop={theme.layout.hitSlop.medium}
            >
              <MaterialCommunityIcons name="trash-can" size={12} color="#fff" />
            </TouchableOpacity>
          </View>
        ))}

        <TouchableOpacity
          style={styles.addThumbnailBtn}
          onPress={() => onCameraPress(section.sk)}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="camera-plus-outline"
            size={26}
            color={theme.colors.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.addThumbnailBtn}
          onPress={() => onUploadPhoto(section.sk)}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="image-plus"
            size={26}
            color={theme.colors.primary}
          />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ── SeverityPicker ─────────────────────────────────────────────────────────
function SeverityPicker({ value, onChange }) {
  return (
    <View style={severityStyles.row}>
      {SEVERITY.map((s) => {
        const selected = value === s.key;
        return (
          <TouchableOpacity
            key={s.key}
            style={[
              severityStyles.chip,
              selected
                ? { backgroundColor: s.color, borderColor: s.color }
                : { backgroundColor: s.bg, borderColor: s.color },
            ]}
            onPress={() => onChange(selected ? null : s.key)}
            activeOpacity={0.75}
          >
            <View
              style={[
                severityStyles.dot,
                { backgroundColor: selected ? "rgba(255,255,255,0.85)" : s.color },
              ]}
            />
            <Text
              style={[
                severityStyles.chipLabel,
                { color: selected ? "#fff" : s.color },
              ]}
            >
              {s.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const severityStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  chip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 7,
    borderRadius: theme.layout.borderRadius.full,
    borderWidth: 1.5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  chipLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
});

// ── Styles ─────────────────────────────────────────────────────────────────
const THUMB = 90;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.mainBackground },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    backgroundColor: theme.colors.cardBackground,
    borderBottomWidth: 0,
    ...theme.shadows.light,
  },
  navTitle: {
    ...theme.typography.h4,
    flex: 1,
    marginHorizontal: theme.spacing.s,
  },
  saveIndicatorContainer: {
    width: 44,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  saveIndicatorInner: {
    alignItems: "center",
    justifyContent: "center",
  },

  summaryHeader: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.s,
  },
  footerContent: {
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.s,
    paddingBottom: theme.spacing.xxl,
  },

  overline: {
    ...theme.typography.overline,
    marginBottom: theme.spacing.s,
  },
  input: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    ...theme.typography.body,
    minHeight: 42,
  },
  textArea: { minHeight: 90, paddingTop: theme.spacing.s },

  section: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    padding: theme.spacing.m,
    marginHorizontal: theme.spacing.m,
    marginBottom: theme.spacing.m,
    gap: theme.spacing.s,
    ...theme.shadows.light,
  },
  sectionActive: {
    ...theme.shadows.dark,
    opacity: 0.96,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dragHandle: {
    paddingRight: theme.spacing.s,
  },
  sectionNameInput: {
    flex: 1,
    ...theme.typography.bodyBold,
    color: theme.colors.primary,
    paddingVertical: 2,
  },

  separator: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.input,
  },
  separatorCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: theme.spacing.xs,
    backgroundColor: theme.colors.mainBackground,
  },

  thumbnailRow: {
    flexDirection: "row",
    gap: theme.spacing.s,
    paddingVertical: theme.spacing.xs,
  },
  thumbnailContainer: {
    width: THUMB,
    height: THUMB,
  },
  thumbnailWrapper: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme.layout.borderRadius.s,
    overflow: "hidden",
  },
  thumbnail: {
    width: THUMB,
    height: THUMB,
  },
  thumbnailDot: {
    position: "absolute",
    bottom: 5,
    right: 5,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
    borderWidth: 1,
    borderColor: "#fff",
  },
  thumbnailDelete: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  addThumbnailBtn: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.primary,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primaryGhost,
  },

  addSectionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.s,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.l,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.primary,
    borderStyle: "dashed",
    backgroundColor: theme.colors.primaryGhost,
  },
  addSectionText: {
    ...theme.typography.bodyBold,
    color: theme.colors.primary,
  },
});
