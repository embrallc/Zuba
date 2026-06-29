import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import VoiceFab from "../components/VoiceFab";
import AiRewriteSheet from "../components/walkthrough/AiRewriteSheet";
import WalkField, { PhotoModal } from "../components/walkthrough/WalkField";
import { logError } from "../db/logs";
import { SEVERITY_LEVELS } from "../shared/walkthroughSchema";
import { requestRewrite, rewriteErrorMessage } from "../utils/aiRewrite";
import {
  ensureInspectionForm,
  fetchAndCacheTemplate,
  getCachedTemplate,
  newId,
  saveAnswers,
} from "../db/walkthroughForms";
import { useInspectionStore } from "../stores/useInspectionStore";
import { usePhotoCaptureStore, usePhotoMarkupStore } from "../stores/usePhotoWorkflow";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  deleteCachedPhoto,
  deleteInspectionPhoto,
  processAndCachePhoto,
  resolvePhotoUri,
  savePhotoToDevice,
} from "../utils/inspectionPhotos";

const clone = (o) => JSON.parse(JSON.stringify(o ?? { sections: {} }));

function findInstance(a, secId, instId) {
  return (
    a?.sections?.[secId]?.instances?.find((i) => i.instanceId === instId) ?? null
  );
}

// Ensure every schema section has an answers entry, and every static section
// has exactly one instance to render into. Snapshot + answers come from the
// same template so they're already consistent; this is defensive.
function normalizeAnswers(schema, answers) {
  const a = clone(answers);
  if (!a.sections) a.sections = {};
  for (const sec of schema?.sections ?? []) {
    if (!a.sections[sec.id]) a.sections[sec.id] = { instances: [] };
    if (
      sec.kind === "static" &&
      a.sections[sec.id].instances.length === 0
    ) {
      a.sections[sec.id].instances.push({ instanceId: newId("i"), fields: {} });
    }
  }
  return a;
}

export default function InspectionFormScreen() {
  const router = useRouter();
  const { inspectionSk } = useLocalSearchParams();
  const inspection = useInspectionStore((s) => s.getById(inspectionSk));
  const aiRewriteEnabled = useSettingsStore((s) => s.aiRewriteEnabled);

  const [schema, setSchema] = useState(null);
  const [answers, setAnswers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [openPhoto, setOpenPhoto] = useState(null); // { sectionId, instanceId, fieldId, photoId }
  // AI Rewrite. `rewriteBusy` drives the per-field ✨ spinner (the field/note
  // whose rewrite is in flight). `rewriteSheet` is the open review surface;
  // `sheetLoading` covers a Regenerate from inside it.
  const [rewriteBusy, setRewriteBusy] = useState(null); // {sectionId,instanceId,fieldId,photoId?}
  const [rewriteSheet, setRewriteSheet] = useState(null); // + {original, suggestion}
  const [sheetLoading, setSheetLoading] = useState(false);

  const answersRef = useRef({ sections: {} });
  const dirtyRef = useRef(false);
  const saveTimer = useRef(null);

  // Keyboard metrics so the voice mic floats just above the keyboard while a
  // text field is open (and drops to the corner when it's dismissed).
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(show, (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
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

  // ── Load: snapshot the published template on first open ──────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const orgSk = useSettingsStore.getState().orgSk;
        let cached = await getCachedTemplate(orgSk);
        if (!cached?.schema && orgSk) {
          cached = await fetchAndCacheTemplate(orgSk);
        }
        const form = await ensureInspectionForm(
          inspectionSk,
          cached?.schema ?? null,
          cached?.version ?? 0,
        );
        if (!alive) return;
        const sch = form?.schema ?? null;
        const norm = normalizeAnswers(sch, form?.answers);
        setSchema(sch);
        setAnswers(norm);
        answersRef.current = norm;
      } catch (e) {
        logError(e, `InspectionFormScreen.load sk=${inspectionSk}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [inspectionSk]);

  // ── Save (debounced) ─────────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    dirtyRef.current = false;
    try {
      await saveAnswers(inspectionSk, answersRef.current);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1400);
    } catch (e) {
      logError(e, `InspectionFormScreen.save sk=${inspectionSk}`);
      setSaveState("idle");
    }
  }, [inspectionSk]);

  function scheduleSave() {
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 700);
  }

  // Flush a pending edit on unmount so nothing is lost on a fast back-out.
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      if (dirtyRef.current) {
        saveAnswers(inspectionSk, answersRef.current).catch(() => {});
      }
    };
  }, [inspectionSk]);

  // ── Answers mutation ─────────────────────────────────────────────────────
  // rerender=false is used by text fields, which hold their own input state —
  // skipping the parent re-render keeps typing perfectly smooth.
  function mutateAnswers(fn, rerender = true) {
    const next = clone(answersRef.current);
    fn(next);
    answersRef.current = next;
    dirtyRef.current = true;
    if (rerender) setAnswers(next);
    scheduleSave();
  }

  function setValue(secId, instId, fId, value, rerender = true) {
    mutateAnswers((a) => {
      const inst = findInstance(a, secId, instId);
      if (inst) inst.fields[fId] = value;
    }, rerender);
  }

  function addInstance(secId) {
    mutateAnswers((a) => {
      if (!a.sections[secId]) a.sections[secId] = { instances: [] };
      a.sections[secId].instances.push({ instanceId: newId("i"), fields: {} });
    });
  }

  function removeInstance(secId, instId) {
    const inst = findInstance(answersRef.current, secId, instId);
    const photoRefs = [];
    if (inst) {
      for (const val of Object.values(inst.fields ?? {})) {
        if (Array.isArray(val)) {
          for (const p of val) {
            if (p && typeof p === "object" && p.id) photoRefs.push(p);
          }
        }
      }
    }
    mutateAnswers((a) => {
      const sec = a.sections?.[secId];
      if (sec) sec.instances = sec.instances.filter((i) => i.instanceId !== instId);
    });
    for (const p of photoRefs) {
      if (p.cloudUri) deleteInspectionPhoto(p.cloudUri);
      deleteCachedPhoto(p.id);
    }
  }

  function confirmRemoveInstance(secId, instId, label) {
    Alert.alert("Remove?", `Remove "${label}" and its photos?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeInstance(secId, instId),
      },
    ]);
  }

  // ── Photos ───────────────────────────────────────────────────────────────
  function addPhoto(secId, instId, fId, photoRef) {
    mutateAnswers((a) => {
      const inst = findInstance(a, secId, instId);
      if (!inst) return;
      const arr = Array.isArray(inst.fields[fId]) ? inst.fields[fId] : [];
      inst.fields[fId] = [...arr, photoRef];
    });
  }

  function updatePhoto(secId, instId, fId, photoId, patch) {
    mutateAnswers((a) => {
      const inst = findInstance(a, secId, instId);
      const arr = inst?.fields?.[fId];
      if (!Array.isArray(arr)) return;
      inst.fields[fId] = arr.map((p) => (p.id === photoId ? { ...p, ...patch } : p));
    });
  }

  function removePhoto(secId, instId, fId, photoId) {
    const inst = findInstance(answersRef.current, secId, instId);
    const arr = inst?.fields?.[fId];
    const ref = Array.isArray(arr) ? arr.find((p) => p.id === photoId) : null;
    mutateAnswers((a) => {
      const i2 = findInstance(a, secId, instId);
      if (i2 && Array.isArray(i2.fields[fId])) {
        i2.fields[fId] = i2.fields[fId].filter((p) => p.id !== photoId);
      }
    });
    if (ref?.cloudUri) deleteInspectionPhoto(ref.cloudUri);
    deleteCachedPhoto(photoId);
    setOpenPhoto(null);
  }

  function applyMarkup(photoId, markup) {
    mutateAnswers((a) => {
      for (const sec of Object.values(a.sections ?? {})) {
        for (const inst of sec.instances ?? []) {
          for (const val of Object.values(inst.fields ?? {})) {
            if (Array.isArray(val)) {
              const p = val.find(
                (x) => x && typeof x === "object" && x.id === photoId,
              );
              if (p) {
                p.markup = markup;
                return;
              }
            }
          }
        }
      }
    });
  }

  async function pickFromLibrary(secId, instId, fId) {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Allow photo library access to add pictures.",
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
        const id = newId("p");
        const cachePath = await processAndCachePhoto(asset.uri, id);
        addPhoto(secId, instId, fId, {
          id,
          localUri: cachePath ?? asset.uri,
          cloudUri: null,
          note: "",
          markup: null,
        });
      }
    } catch (e) {
      logError(e, "InspectionFormScreen.pickFromLibrary");
    }
  }

  function makePhotoApi(secId, instId, fId) {
    return {
      onCamera: () => {
        usePhotoCaptureStore.getState().beginCapture({
          inspectionSk,
          sectionId: secId,
          instanceId: instId,
          fieldId: fId,
        });
        router.push("/camera");
      },
      onLibrary: () => pickFromLibrary(secId, instId, fId),
      onOpen: (photoId) =>
        setOpenPhoto({ sectionId: secId, instanceId: instId, fieldId: fId, photoId }),
      onDelete: (photoId) => removePhoto(secId, instId, fId, photoId),
    };
  }

  function getOpenPhotoRef() {
    if (!openPhoto) return null;
    const inst = findInstance(
      answersRef.current,
      openPhoto.sectionId,
      openPhoto.instanceId,
    );
    const arr = inst?.fields?.[openPhoto.fieldId];
    return Array.isArray(arr)
      ? arr.find((p) => p.id === openPhoto.photoId) ?? null
      : null;
  }

  async function openMarkup() {
    const ref = getOpenPhotoRef();
    if (!ref) return;
    const uri = await resolvePhotoUri({
      localUri: ref.localUri,
      cloudUri: ref.cloudUri,
    });
    setOpenPhoto(null);
    router.push({
      pathname: "/photoedit",
      params: {
        uri: uri ?? "",
        initialMarkup:
          typeof ref.markup === "string"
            ? ref.markup
            : ref.markup
              ? JSON.stringify(ref.markup)
              : "",
        target: ref.id,
      },
    });
  }

  // ── AI Rewrite ───────────────────────────────────────────────────────────
  // Format a sibling field's answer into a short context string so the rewrite
  // can be specific (e.g. "Issues: Cracks, Granule loss; Condition: Critical").
  function formatFieldValue(field, value) {
    if (value == null || value === "") return null;
    switch (field.type) {
      case "toggle":
        return value === true ? "Yes" : value === false ? "No" : null;
      case "radio": {
        const o = (field.config?.options ?? []).find((x) => x.id === value);
        return o?.label ?? null;
      }
      case "checkbox": {
        if (!Array.isArray(value) || value.length === 0) return null;
        const labels = value
          .map((id) => (field.config?.options ?? []).find((x) => x.id === id)?.label)
          .filter(Boolean);
        return labels.length ? labels.join(", ") : null;
      }
      case "severity": {
        const lvl = SEVERITY_LEVELS.find((l) => l.key === value);
        return lvl?.label ?? null;
      }
      case "text":
        return typeof value === "string" && value.trim() ? value.trim() : null;
      default:
        return null;
    }
  }

  // Sibling answers in the same instance (excluding the field being rewritten,
  // headings, and photos) become context. It's all property findings — never
  // client PII (that lives on the Inspections row, not in walkthrough answers).
  function buildContext(section, instance, fieldId) {
    const out = [];
    for (const f of section?.fields ?? []) {
      if (f.id === fieldId || f.type === "heading" || f.type === "photo") continue;
      const v = formatFieldValue(f, instance?.fields?.[f.id]);
      if (v) out.push({ label: f.label, value: v });
    }
    return out;
  }

  function handleRewriteError(e) {
    Alert.alert("AI Rewrite", rewriteErrorMessage(e?.code));
  }

  function rewritePayload(sectionId, instanceId, fieldId, photoId, text, regenerate) {
    const section = schema?.sections?.find((sx) => sx.id === sectionId);
    const instance = findInstance(answersRef.current, sectionId, instanceId);
    const field = section?.fields?.find((fx) => fx.id === fieldId);
    return {
      text,
      fieldLabel: photoId ? `${field?.label ?? "Photo"} note` : field?.label,
      sectionTitle: section?.title,
      context: buildContext(section, instance, fieldId),
      regenerate,
    };
  }

  // Kick off a rewrite for a form field (photoId undefined) or a photo note
  // (photoId set). The in-flight lock doubles as the button debounce.
  async function startRewrite({ sectionId, instanceId, fieldId, photoId, text }) {
    if (rewriteBusy) return;
    const trimmed = (text ?? "").trim();
    if (!trimmed) return;
    Keyboard.dismiss();
    setRewriteBusy({ sectionId, instanceId, fieldId, photoId });
    try {
      const suggestion = await requestRewrite(
        rewritePayload(sectionId, instanceId, fieldId, photoId, trimmed, false),
      );
      setRewriteSheet({ sectionId, instanceId, fieldId, photoId, original: trimmed, suggestion });
    } catch (e) {
      handleRewriteError(e);
    } finally {
      setRewriteBusy(null);
    }
  }

  async function regenerateRewrite() {
    if (!rewriteSheet || sheetLoading) return;
    setSheetLoading(true);
    try {
      const { sectionId, instanceId, fieldId, photoId, original } = rewriteSheet;
      const suggestion = await requestRewrite(
        rewritePayload(sectionId, instanceId, fieldId, photoId, original, true),
      );
      setRewriteSheet((s) => (s ? { ...s, suggestion } : s));
    } catch (e) {
      handleRewriteError(e);
    } finally {
      setSheetLoading(false);
    }
  }

  function applyRewrite() {
    if (!rewriteSheet) return;
    const { sectionId, instanceId, fieldId, photoId, suggestion } = rewriteSheet;
    const text = (suggestion ?? "").trim();
    if (text) {
      if (photoId) updatePhoto(sectionId, instanceId, fieldId, photoId, { note: text });
      else setValue(sectionId, instanceId, fieldId, text, true);
    }
    setRewriteSheet(null);
  }

  function makeTextAi(section, instance, field) {
    if (!aiRewriteEnabled) return undefined;
    const busy =
      rewriteBusy &&
      !rewriteBusy.photoId &&
      rewriteBusy.sectionId === section.id &&
      rewriteBusy.instanceId === instance.instanceId &&
      rewriteBusy.fieldId === field.id;
    return {
      enabled: true,
      loading: !!busy,
      onRequest: (text) =>
        startRewrite({
          sectionId: section.id,
          instanceId: instance.instanceId,
          fieldId: field.id,
          text,
        }),
    };
  }

  // The review sheet is an overlay (not a Modal), so it can render at the form
  // root for field rewrites OR inside the photo modal for note rewrites — a
  // second Modal won't reliably present over the photo Modal.
  function renderRewriteSheet() {
    return (
      <AiRewriteSheet
        visible
        original={rewriteSheet?.original ?? ""}
        suggestion={rewriteSheet?.suggestion ?? ""}
        loading={sheetLoading}
        onChangeSuggestion={(t) =>
          setRewriteSheet((s) => (s ? { ...s, suggestion: t } : s))
        }
        onRegenerate={regenerateRewrite}
        onUse={applyRewrite}
        onKeepMine={() => setRewriteSheet(null)}
      />
    );
  }

  // ── Pick up camera captures + markup results on return ───────────────────
  useFocusEffect(
    useCallback(() => {
      const cap = usePhotoCaptureStore.getState();
      if (cap.target?.inspectionSk === inspectionSk && cap.captures.length) {
        const { sectionId, instanceId, fieldId } = cap.target;
        const uris = cap.captures;
        usePhotoCaptureStore.getState().clear();
        // Opt-in device-library save (Settings → Photos). Read once here, not
        // reactively — camera captures only; library picks already live in the
        // gallery so they're intentionally not saved.
        const { persistPhotosToDevice, photoAlbumEnabled } =
          useSettingsStore.getState();
        (async () => {
          for (const tempUri of uris) {
            const id = newId("p");
            const cachePath = await processAndCachePhoto(tempUri, id);
            addPhoto(sectionId, instanceId, fieldId, {
              id,
              localUri: cachePath ?? tempUri,
              cloudUri: null,
              note: "",
              markup: null,
            });
            if (persistPhotosToDevice && cachePath) {
              await savePhotoToDevice(cachePath, { album: photoAlbumEnabled });
            }
          }
        })();
      }

      const mk = usePhotoMarkupStore.getState();
      if (mk.result) {
        const { photoId, markup } = mk.result;
        usePhotoMarkupStore.getState().clear();
        applyMarkup(photoId, markup);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inspectionSk]),
  );

  // ── Render ───────────────────────────────────────────────────────────────
  const title = inspection?.FullName
    ? `${inspection.FullName} — ${dayjs(inspection.ScheduledAt).format("MMM D")}`
    : "Walkthrough";

  function renderFields(section, instance) {
    return section.fields.map((f) => {
      if (f.type === "heading") {
        return <WalkField key={f.id} field={f} />;
      }
      const value = instance.fields?.[f.id];
      if (f.type === "photo") {
        return (
          <WalkField
            key={f.id}
            field={f}
            value={value}
            photo={makePhotoApi(section.id, instance.instanceId, f.id)}
          />
        );
      }
      const rerender = f.type !== "text";
      return (
        <WalkField
          key={f.id}
          field={f}
          value={value}
          onChange={(v) =>
            setValue(section.id, instance.instanceId, f.id, v, rerender)
          }
          ai={f.type === "text" ? makeTextAi(section, instance, f) : undefined}
        />
      );
    });
  }

  function renderSection(section) {
    const secAns = answers?.sections?.[section.id] ?? { instances: [] };

    if (section.kind === "static") {
      const inst = secAns.instances[0];
      return (
        <View key={section.id} style={styles.card}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {inst && renderFields(section, inst)}
        </View>
      );
    }

    // Repeatable
    return (
      <View key={section.id} style={styles.repeatBlock}>
        <Text style={styles.repeatTitle}>{section.title}</Text>
        {secAns.instances.length === 0 && (
          <Text style={styles.emptyRepeat}>
            None added yet. Tap below to add one.
          </Text>
        )}
        {secAns.instances.map((inst, idx) => (
          <View key={inst.instanceId} style={styles.card}>
            <View style={styles.instanceHeader}>
              <Text style={styles.instanceTitle}>
                {section.title} {idx + 1}
              </Text>
              <TouchableOpacity
                onPress={() =>
                  confirmRemoveInstance(
                    section.id,
                    inst.instanceId,
                    `${section.title} ${idx + 1}`,
                  )
                }
                hitSlop={theme?.layout?.hitSlop?.medium}
              >
                <MaterialCommunityIcons
                  name="trash-can-outline"
                  size={20}
                  color={theme?.colors?.textSubtle}
                />
              </TouchableOpacity>
            </View>
            {renderFields(section, inst)}
          </View>
        ))}
        <TouchableOpacity
          style={styles.addInstanceBtn}
          onPress={() => addInstance(section.id)}
          activeOpacity={0.8}
        >
          <MaterialCommunityIcons
            name="plus-circle-outline"
            size={20}
            color={theme?.colors?.primary}
          />
          <Text style={styles.addInstanceText}>
            {section.addLabel || "Add"}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          <MaterialCommunityIcons
            name="close"
            size={theme?.layout?.iconSize?.l ?? 26}
            color={theme?.colors?.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.saveIndicator}>
          {saveState === "saving" && (
            <ActivityIndicator size="small" color={theme?.colors?.primary} />
          )}
          {saveState === "saved" && (
            <MaterialCommunityIcons
              name="check-circle"
              size={20}
              color={theme?.colors?.success}
            />
          )}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator
          style={{ flex: 1 }}
          size="large"
          color={theme?.colors?.primary}
        />
      ) : !schema ? (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons
            name="clipboard-alert-outline"
            size={44}
            color={theme?.colors?.textFine}
          />
          <Text style={styles.emptyTitle}>No walkthrough form yet</Text>
          <Text style={styles.emptyBody}>
            Your organization's walkthrough form hasn't been published. Ask the
            owner to design and publish it from the Form Builder, then reopen
            this inspection.
          </Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {(schema.sections ?? []).map(renderSection)}
            {(schema.sections ?? []).length === 0 && (
              <Text style={styles.emptyBody}>
                This form has no sections yet.
              </Text>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {!loading && schema && (
        <VoiceFab
          keyboardVisible={keyboardVisible}
          keyboardHeight={keyboardHeight}
        />
      )}

      <PhotoModal
        visible={!!openPhoto}
        photoRef={getOpenPhotoRef()}
        onClose={() => setOpenPhoto(null)}
        onNoteChange={(note) =>
          openPhoto &&
          updatePhoto(
            openPhoto.sectionId,
            openPhoto.instanceId,
            openPhoto.fieldId,
            openPhoto.photoId,
            { note },
          )
        }
        onMarkup={openMarkup}
        onDelete={() =>
          openPhoto &&
          removePhoto(
            openPhoto.sectionId,
            openPhoto.instanceId,
            openPhoto.fieldId,
            openPhoto.photoId,
          )
        }
        ai={
          openPhoto && aiRewriteEnabled
            ? {
                enabled: true,
                loading: rewriteBusy?.photoId === openPhoto.photoId,
                onRequest: (noteText) =>
                  startRewrite({
                    sectionId: openPhoto.sectionId,
                    instanceId: openPhoto.instanceId,
                    fieldId: openPhoto.fieldId,
                    photoId: openPhoto.photoId,
                    text: noteText,
                  }),
              }
            : undefined
        }
        rewriteOverlay={rewriteSheet?.photoId ? renderRewriteSheet() : null}
      />

      {rewriteSheet && !rewriteSheet.photoId ? renderRewriteSheet() : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme?.colors?.mainBackground },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    ...theme?.shadows?.light,
  },
  navTitle: {
    ...theme?.typography?.h4,
    flex: 1,
    marginHorizontal: theme?.spacing?.s,
  },
  saveIndicator: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  scroll: {
    padding: theme?.spacing?.m,
    paddingBottom: 80,
  },
  card: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.l ?? 14,
    padding: theme?.spacing?.m,
    marginBottom: theme?.spacing?.m,
    ...theme?.shadows?.light,
  },
  sectionTitle: {
    ...theme?.typography?.h4,
    marginBottom: theme?.spacing?.m,
    color: theme?.colors?.text,
  },

  repeatBlock: {
    marginBottom: theme?.spacing?.m,
  },
  repeatTitle: {
    ...theme?.typography?.h4,
    color: theme?.colors?.text,
    marginBottom: theme?.spacing?.s,
    paddingLeft: 2,
  },
  emptyRepeat: {
    fontSize: 13,
    color: theme?.colors?.textFine,
    fontStyle: "italic",
    marginBottom: theme?.spacing?.s,
    paddingLeft: 2,
  },
  instanceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme?.spacing?.s,
  },
  instanceTitle: {
    ...theme?.typography?.bodyBold,
    color: theme?.colors?.primary,
  },
  addInstanceBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.s,
    paddingVertical: theme?.spacing?.m,
    borderRadius: theme?.layout?.borderRadius?.l ?? 14,
    borderWidth: 1,
    borderColor: theme?.colors?.primary,
    borderStyle: "dashed",
    backgroundColor: theme?.colors?.primaryGhost,
  },
  addInstanceText: {
    ...theme?.typography?.bodyBold,
    color: theme?.colors?.primary,
  },

  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10,
  },
  emptyTitle: {
    ...theme?.typography?.h4,
    color: theme?.colors?.text,
    marginTop: 6,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 21,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
  },
});
