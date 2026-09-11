import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { resolvePhotoUri } from "../../utils/inspectionPhotos";

// One scanned value injected at the bottom of a walkthrough card. A labeled,
// editable text field (so the inspector can correct OCR) with a delete button,
// plus the tag photo as a thumbnail — tap it to view full-screen and verify the
// value against the label later, without re-reading it on the appliance.
// `scan` = { id, tool, kind, label, value, capturedAt, photo? }.
export default function ScanField({ scan, onChange, onDelete }) {
  const [text, setText] = useState(scan?.value ?? "");
  const [focused, setFocused] = useState(false);
  const [thumbUri, setThumbUri] = useState(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    if (!focused && (scan?.value ?? "") !== text) setText(scan?.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan?.value]);

  useEffect(() => {
    let alive = true;
    const photo = scan?.photo;
    if (!photo) {
      setThumbUri(null);
      return;
    }
    (async () => {
      const u = await resolvePhotoUri({
        localUri: photo.localUri,
        cloudUri: photo.cloudUri,
        detailSk: photo.id,
      });
      if (alive) setThumbUri(u);
    })();
    return () => {
      alive = false;
    };
  }, [scan?.photo?.localUri, scan?.photo?.cloudUri, scan?.photo?.id]);

  const apply = (t) => {
    setText(t);
    onChange?.(t);
  };

  const hasPhoto = !!scan?.photo;

  return (
    <View style={s.block}>
      <View style={s.labelRow}>
        <View style={s.labelLeft}>
          <MaterialCommunityIcons
            name="barcode-scan"
            size={14}
            color={theme?.colors?.primary}
          />
          <Text style={s.label} numberOfLines={1}>
            {scan?.label || "Scan"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onDelete}
          hitSlop={theme?.layout?.hitSlop?.medium}
          style={s.delBtn}
          accessibilityLabel="Remove scan"
        >
          <MaterialCommunityIcons
            name="close"
            size={16}
            color={theme?.colors?.textSubtle}
          />
        </TouchableOpacity>
      </View>

      <View style={s.body}>
        <TextInput
          style={[s.input, hasPhoto && s.inputWithThumb]}
          value={text}
          onChangeText={apply}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          multiline
          placeholder="Scanned text…"
          placeholderTextColor={theme?.colors?.textFine}
          textAlignVertical="top"
        />
        {hasPhoto && (
          <TouchableOpacity
            style={s.thumb}
            onPress={() => setViewerOpen(true)}
            activeOpacity={0.85}
            accessibilityLabel="View tag photo"
          >
            {thumbUri ? (
              <Image source={{ uri: thumbUri }} style={s.thumbImg} />
            ) : (
              <ActivityIndicator size="small" color={theme?.colors?.primary} />
            )}
          </TouchableOpacity>
        )}
      </View>

      <Modal
        visible={viewerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerOpen(false)}
      >
        <TouchableOpacity
          style={s.viewerBg}
          activeOpacity={1}
          onPress={() => setViewerOpen(false)}
        >
          {thumbUri && (
            <Image
              source={{ uri: thumbUri }}
              style={s.viewerImg}
              resizeMode="contain"
            />
          )}
          <View style={s.viewerClose}>
            <MaterialCommunityIcons name="close" size={26} color="#fff" />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const THUMB = 56;

const s = StyleSheet.create({
  block: {
    marginTop: 4,
    marginBottom: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme?.colors?.input,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  labelLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flex: 1,
    paddingRight: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.2,
    color: theme?.colors?.primary,
  },
  delBtn: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme?.colors?.mainBackground,
  },
  body: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  input: {
    flex: 1,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: theme?.colors?.text,
    minHeight: THUMB,
    lineHeight: 21,
  },
  inputWithThumb: {},
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    overflow: "hidden",
    backgroundColor: theme?.colors?.input,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbImg: { width: THUMB, height: THUMB },
  viewerBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerImg: { width: "100%", height: "80%" },
  viewerClose: { position: "absolute", top: 50, right: 24 },
});
