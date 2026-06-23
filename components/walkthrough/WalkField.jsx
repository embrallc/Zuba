import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import KeyboardToolbar from "../KeyboardToolbar";
import { useVoiceField } from "../../hooks/useVoiceField";
import { SEVERITY_LEVELS } from "../../shared/walkthroughSchema";
import { resolvePhotoUri } from "../../utils/inspectionPhotos";

// Renders one field of a walkthrough section instance the way the inspector
// fills it in. The form owns the answers; each field just reflects `value` and
// reports changes through `onChange`. Photo fields get a `photo` handler bag.

export function markupHasStrokes(markup) {
  if (!markup) return false;
  try {
    const parsed = typeof markup === "string" ? JSON.parse(markup) : markup;
    return Array.isArray(parsed?.strokes) && parsed.strokes.length > 0;
  } catch (_) {
    return false;
  }
}

function FieldLabel({ field }) {
  return (
    <Text style={s.label}>
      {field.label}
      {field.required ? <Text style={s.req}> *</Text> : null}
    </Text>
  );
}

// ── Text ─────────────────────────────────────────────────────────────────────
function TextField({ field, value, onChange, ai }) {
  const variant = field.config?.variant ?? "line";
  // Local state keeps typing smooth and lets the parent skip re-renders on
  // every keystroke (it only persists to the answers ref + debounced save).
  const [text, setText] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  const multiline = variant === "multiline";

  // One setter for both sources of input: the keyboard and voice dictation.
  // Updating local state + propagating up keeps typing smooth, and lets the
  // voice engine write straight into this field once it's the focused target.
  const applyText = (t) => {
    setText(t);
    onChange(t);
  };
  // Register this input with the dictation engine on focus; whatever the user
  // last tapped becomes the field new transcripts land in.
  const voice = useVoiceField(text, applyText);

  // Adopt external value changes (e.g. an accepted AI rewrite applied from the
  // parent) — but only while unfocused, so a stray re-render can't clobber
  // in-progress typing.
  useEffect(() => {
    if (!focused && (value ?? "") !== text) setText(value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // ✨ Rewrite is offered only on multiline (prose) fields that have content.
  const showAi = !!ai?.enabled && multiline && !!text.trim();

  return (
    <View style={s.block}>
      <View style={s.labelRow}>
        <FieldLabel field={field} />
        {showAi ? (
          <TouchableOpacity
            style={s.aiBtn}
            onPress={() => ai.onRequest(text)}
            disabled={ai.loading}
            hitSlop={theme?.layout?.hitSlop?.small}
            activeOpacity={0.7}
          >
            {ai.loading ? (
              <ActivityIndicator size="small" color={theme?.colors?.primary} />
            ) : (
              <>
                <MaterialCommunityIcons
                  name="auto-fix"
                  size={15}
                  color={theme?.colors?.primary}
                />
                <Text style={s.aiBtnTxt}>Rewrite</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
      <TextInput
        style={[
          s.input,
          variant === "line" && s.inputLine,
          multiline && s.inputArea,
        ]}
        value={text}
        onChangeText={applyText}
        onFocus={() => {
          setFocused(true);
          voice.onFocus();
        }}
        onBlur={() => setFocused(false)}
        multiline={multiline}
        placeholder={multiline ? "Type here…" : ""}
        placeholderTextColor={theme?.colors?.textFine}
        textAlignVertical={multiline ? "top" : "center"}
      />
    </View>
  );
}

// ── Toggle (Yes / No) ────────────────────────────────────────────────────────
function ToggleField({ field, value, onChange }) {
  return (
    <View style={s.inlineRow}>
      <Text style={[s.label, s.labelInline]}>
        {field.label}
        {field.required ? <Text style={s.req}> *</Text> : null}
      </Text>
      <View style={s.toggle}>
        <TouchableOpacity
          style={[s.toggleBtn, value === true && s.toggleOn]}
          onPress={() => onChange(value === true ? undefined : true)}
          activeOpacity={0.8}
        >
          <Text style={[s.toggleTxt, value === true && s.toggleTxtOn]}>Yes</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.toggleBtn, value === false && s.toggleOn]}
          onPress={() => onChange(value === false ? undefined : false)}
          activeOpacity={0.8}
        >
          <Text style={[s.toggleTxt, value === false && s.toggleTxtOn]}>No</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Radio / Checkbox ─────────────────────────────────────────────────────────
function ChoiceField({ field, value, onChange, multi }) {
  const opts = field.config?.options ?? [];
  const selected = multi ? (Array.isArray(value) ? value : []) : value;

  function toggle(optId) {
    if (multi) {
      const set = new Set(selected);
      if (set.has(optId)) set.delete(optId);
      else set.add(optId);
      onChange([...set]);
    } else {
      onChange(selected === optId ? null : optId);
    }
  }

  return (
    <View style={s.block}>
      <FieldLabel field={field} />
      {opts.length === 0 && <Text style={s.muted}>No options configured.</Text>}
      {opts.map((o) => {
        const on = multi ? selected.includes(o.id) : selected === o.id;
        return (
          <TouchableOpacity
            key={o.id}
            style={s.optRow}
            onPress={() => toggle(o.id)}
            activeOpacity={0.7}
          >
            <View
              style={[
                multi ? s.checkbox : s.radio,
                on && s.markOn,
              ]}
            >
              {on && (
                <MaterialCommunityIcons
                  name={multi ? "check" : "circle"}
                  size={multi ? 13 : 10}
                  color="#fff"
                />
              )}
            </View>
            <Text style={s.optLabel}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Severity ─────────────────────────────────────────────────────────────────
function SeverityField({ field, value, onChange }) {
  return (
    <View style={s.block}>
      <FieldLabel field={field} />
      <View style={s.sevRow}>
        {SEVERITY_LEVELS.map((lvl) => {
          const on = value === lvl.key;
          return (
            <TouchableOpacity
              key={lvl.key}
              onPress={() => onChange(on ? null : lvl.key)}
              activeOpacity={0.75}
              style={[
                s.sevChip,
                on
                  ? { backgroundColor: lvl.color, borderColor: lvl.color }
                  : { backgroundColor: lvl.bg, borderColor: lvl.color },
              ]}
            >
              <View
                style={[
                  s.sevDot,
                  { backgroundColor: on ? "rgba(255,255,255,0.85)" : lvl.color },
                ]}
              />
              <Text style={[s.sevLabel, { color: on ? "#fff" : lvl.color }]}>
                {lvl.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ── Photos ───────────────────────────────────────────────────────────────────
function PhotoThumb({ photoRef, onPress }) {
  const [uri, setUri] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      const u = await resolvePhotoUri({
        localUri: photoRef.localUri,
        cloudUri: photoRef.cloudUri,
      });
      if (alive) {
        setUri(u);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [photoRef.localUri, photoRef.cloudUri]);

  const hasMarkup = markupHasStrokes(photoRef.markup);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={s.thumb}>
      {!!uri && (
        <Image source={{ uri }} style={s.thumbImg} resizeMode="cover" />
      )}
      {loading && (
        <View style={[StyleSheet.absoluteFillObject, s.thumbLoading]}>
          <ActivityIndicator size="small" color={theme?.colors?.primary} />
        </View>
      )}
      {!!photoRef.note && <View style={s.noteDot} />}
      {hasMarkup && (
        <View style={s.markBadge}>
          <MaterialCommunityIcons name="pencil" size={10} color="#fff" />
        </View>
      )}
    </TouchableOpacity>
  );
}

function PhotoField({ field, value, photo }) {
  const refs = Array.isArray(value) ? value : [];
  return (
    <View style={s.block}>
      <FieldLabel field={field} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.thumbRow}
        keyboardShouldPersistTaps="handled"
      >
        {refs.map((ref) => (
          <View key={ref.id} style={s.thumbContainer}>
            <PhotoThumb photoRef={ref} onPress={() => photo.onOpen(ref.id)} />
            <TouchableOpacity
              style={s.thumbDel}
              onPress={() => photo.onDelete(ref.id)}
              hitSlop={theme?.layout?.hitSlop?.medium}
            >
              <MaterialCommunityIcons name="trash-can" size={12} color="#fff" />
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={s.addThumb} onPress={photo.onCamera} activeOpacity={0.7}>
          <MaterialCommunityIcons
            name="camera-plus-outline"
            size={26}
            color={theme?.colors?.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity style={s.addThumb} onPress={photo.onLibrary} activeOpacity={0.7}>
          <MaterialCommunityIcons
            name="image-plus"
            size={26}
            color={theme?.colors?.primary}
          />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// Full-screen photo viewer with note + markup + delete. The form owns which
// photo is open and supplies the handlers.
export function PhotoModal({
  visible,
  photoRef,
  onClose,
  onNoteChange,
  onMarkup,
  onDelete,
  ai,
  rewriteOverlay,
}) {
  const [uri, setUri] = useState(null);
  const [note, setNote] = useState("");
  // The card is bottom-anchored, so the keyboard would cover the note + actions.
  // Track its height to lift the card above it and float a dismiss toolbar.
  const [kbVisible, setKbVisible] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(show, (e) => {
      setKbVisible(true);
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hide, () => {
      setKbVisible(false);
      setKbHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  // Same dual-source setter as the inline text fields, so voice can dictate
  // a photo note too. Enable the mic before opening the photo — the modal
  // covers the floating button, but the recognition session keeps running.
  const applyNote = (t) => {
    setNote(t);
    onNoteChange(t);
  };
  const voice = useVoiceField(note, applyNote);

  useEffect(() => {
    setNote(photoRef?.note ?? "");
  }, [photoRef?.id]);

  // Adopt an externally-applied note (an accepted AI rewrite). No focus guard
  // needed: typing keeps photoRef.note in sync with `note` (onNoteChange
  // re-renders immediately), so this only fires on a genuine external change —
  // and it must fire even if iOS restored focus to the note when the rewrite
  // sheet (a stacked modal) closed.
  useEffect(() => {
    if ((photoRef?.note ?? "") !== note) {
      setNote(photoRef?.note ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoRef?.note]);

  const showNoteAi = !!ai?.enabled && !!note.trim();

  useEffect(() => {
    let alive = true;
    if (!photoRef) return;
    (async () => {
      const u = await resolvePhotoUri({
        localUri: photoRef.localUri,
        cloudUri: photoRef.cloudUri,
      });
      if (alive) setUri(u);
    })();
    return () => {
      alive = false;
    };
  }, [photoRef?.localUri, photoRef?.cloudUri]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={s.modalBg}>
        <View
          style={[
            s.modalCard,
            kbVisible && { marginBottom: kbHeight + KB_TOOLBAR_GAP },
          ]}
        >
          <View
            style={[s.modalImageWrap, kbVisible && s.modalImageWrapCompact]}
          >
            {!!uri && (
              <Image source={{ uri }} style={s.modalImage} resizeMode="contain" />
            )}
          </View>
          {showNoteAi ? (
            <View style={s.noteAiRow}>
              <TouchableOpacity
                style={s.aiBtn}
                onPress={() => ai.onRequest(note)}
                disabled={ai.loading}
                hitSlop={theme?.layout?.hitSlop?.small}
                activeOpacity={0.7}
              >
                {ai.loading ? (
                  <ActivityIndicator size="small" color={theme?.colors?.primary} />
                ) : (
                  <>
                    <MaterialCommunityIcons
                      name="auto-fix"
                      size={15}
                      color={theme?.colors?.primary}
                    />
                    <Text style={s.aiBtnTxt}>Rewrite</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
          <TextInput
            style={s.modalNote}
            value={note}
            onChangeText={applyNote}
            onFocus={voice.onFocus}
            placeholder="Add a note for this photo…"
            placeholderTextColor={theme?.colors?.textFine}
            multiline
          />
          <View style={s.modalActions}>
            <TouchableOpacity style={s.modalBtn} onPress={onMarkup} activeOpacity={0.8}>
              <MaterialCommunityIcons
                name="pencil"
                size={18}
                color={theme?.colors?.primary}
              />
              <Text style={s.modalBtnTxt}>Markup</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modalBtn, s.modalBtnDanger]}
              onPress={onDelete}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons name="trash-can-outline" size={18} color={theme?.colors?.error} />
              <Text style={[s.modalBtnTxt, { color: theme?.colors?.error }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modalBtn, s.modalBtnPrimary]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={[s.modalBtnTxt, { color: "#fff" }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
        <KeyboardToolbar visible={kbVisible} keyboardHeight={kbHeight} />
        {/* The AI rewrite review surface renders here (an overlay, not a Modal)
            so it appears ON TOP of this photo modal — a stacked Modal wouldn't
            reliably present. */}
        {rewriteOverlay}
      </View>
    </Modal>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
export default function WalkField({ field, value, onChange, photo, ai }) {
  switch (field.type) {
    case "heading":
      return <Text style={s.heading}>{field.label}</Text>;
    case "text":
      return <TextField field={field} value={value} onChange={onChange} ai={ai} />;
    case "toggle":
      return <ToggleField field={field} value={value} onChange={onChange} />;
    case "radio":
      return <ChoiceField field={field} value={value} onChange={onChange} multi={false} />;
    case "checkbox":
      return <ChoiceField field={field} value={value} onChange={onChange} multi />;
    case "severity":
      return <SeverityField field={field} value={value} onChange={onChange} />;
    case "photo":
      return <PhotoField field={field} value={value} photo={photo} />;
    default:
      return null;
  }
}

const THUMB = 90;
// Space reserved below the lifted card for the floating dismiss toolbar.
const KB_TOOLBAR_GAP = 56;

const s = StyleSheet.create({
  block: { marginBottom: 14 },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aiBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 999,
    backgroundColor: theme?.colors?.primaryGhost,
    marginBottom: 7,
  },
  aiBtnTxt: {
    fontSize: 12,
    fontWeight: "700",
    color: theme?.colors?.primary,
  },
  noteAiRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: -4 },
  heading: {
    fontSize: 16,
    fontWeight: "800",
    color: theme?.colors?.text,
    marginTop: 6,
    marginBottom: 8,
  },
  label: {
    fontSize: 13.5,
    fontWeight: "600",
    color: theme?.colors?.text,
    marginBottom: 7,
  },
  labelInline: { marginBottom: 0, flex: 1, paddingRight: 10 },
  req: { color: theme?.colors?.error, fontWeight: "700" },
  muted: { fontSize: 12.5, color: theme?.colors?.textFine, fontStyle: "italic" },

  input: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: theme?.colors?.text,
    minHeight: 42,
  },
  inputLine: {
    borderWidth: 0,
    borderBottomWidth: 1.5,
    borderRadius: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 2,
  },
  inputArea: { minHeight: 86, paddingTop: 10 },

  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  toggle: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    borderRadius: 999,
    overflow: "hidden",
  },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 7 },
  toggleOn: { backgroundColor: theme?.colors?.primary },
  toggleTxt: { fontSize: 13, fontWeight: "700", color: theme?.colors?.textSubtle },
  toggleTxtOn: { color: "#fff" },

  optRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 8,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme?.colors?.input,
    alignItems: "center",
    justifyContent: "center",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme?.colors?.input,
    alignItems: "center",
    justifyContent: "center",
  },
  markOn: {
    backgroundColor: theme?.colors?.primary,
    borderColor: theme?.colors?.primary,
  },
  optLabel: { fontSize: 15, color: theme?.colors?.text, flex: 1 },

  sevRow: { flexDirection: "row", gap: 6 },
  sevChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  sevDot: { width: 7, height: 7, borderRadius: 4 },
  sevLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },

  thumbRow: { flexDirection: "row", gap: 10, paddingVertical: 2 },
  thumbContainer: { width: THUMB, height: THUMB },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    overflow: "hidden",
    backgroundColor: theme?.colors?.input,
  },
  thumbImg: { width: THUMB, height: THUMB },
  thumbLoading: { alignItems: "center", justifyContent: "center" },
  noteDot: {
    position: "absolute",
    bottom: 5,
    right: 5,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme?.colors?.primary,
    borderWidth: 1,
    borderColor: "#fff",
  },
  markBadge: {
    position: "absolute",
    top: 4,
    left: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#16A34A",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbDel: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme?.colors?.error,
    alignItems: "center",
    justifyContent: "center",
  },
  addThumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    borderWidth: 1,
    borderColor: theme?.colors?.primary,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme?.colors?.primaryGhost,
  },

  modalBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: theme?.colors?.cardBackground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 28,
    gap: 12,
  },
  modalImageWrap: {
    height: 320,
    borderRadius: 12,
    backgroundColor: "#000",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  // Shrink the photo while the keyboard is up so the note + actions stay on
  // screen above it.
  modalImageWrapCompact: { height: 170 },
  modalImage: { width: "100%", height: "100%" },
  modalNote: {
    backgroundColor: theme?.colors?.mainBackground,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    padding: 12,
    fontSize: 15,
    color: theme?.colors?.text,
    minHeight: 60,
    textAlignVertical: "top",
  },
  modalActions: { flexDirection: "row", gap: 10 },
  modalBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
  },
  modalBtnTxt: { fontSize: 14, fontWeight: "700", color: theme?.colors?.primary },
  modalBtnDanger: { borderColor: "rgba(220,38,38,0.4)" },
  modalBtnPrimary: {
    flex: 1,
    backgroundColor: theme?.colors?.primary,
    borderColor: theme?.colors?.primary,
  },
});
