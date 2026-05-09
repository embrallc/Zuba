import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { insertDetail } from "../db/inspectionForm";
import { logError } from "../db/logs";

const PHOTOS_DIR = `${FileSystem.documentDirectory}inspection_photos/`;

export default function CameraScreen() {
  const router = useRouter();
  const { sectionSk } = useLocalSearchParams();
  const [permission, requestPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();
  const cameraRef = useRef(null);

  // URIs held in memory — only temp paths from the camera, displayed immediately
  const [capturedUris, setCapturedUris] = useState([]);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleCapture() {
    if (capturing || saving || !cameraRef.current) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: true,
      });
      // Save to device photo library so it appears in albums
      let perm = mediaPermission;
      if (!perm?.granted) {
        perm = await requestMediaPermission();
      }
      if (perm?.granted) {
        await MediaLibrary.saveToLibraryAsync(photo.uri);
      }
      setCapturedUris((prev) => [photo.uri, ...prev]);
    } catch (e) {
      logError(e, "CameraScreen.handleCapture");
    } finally {
      setCapturing(false);
    }
  }

  async function handleDone() {
    if (capturedUris.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      // Create permanent dir once
      await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
      // Copy each photo to permanent storage then write DB record
      for (let i = 0; i < capturedUris.length; i++) {
        const dest = `${PHOTOS_DIR}${Date.now()}_${i}.jpg`;
        await FileSystem.copyAsync({ from: capturedUris[i], to: dest });
        await insertDetail(sectionSk, { pictureURI: dest });
      }
    } catch (e) {
      logError(e, "CameraScreen.handleDone");
    }
    // Navigate back after all saves — useFocusEffect in inspectionform reloads
    router.back();
  }

  if (!permission) {
    return <View style={styles.bg} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permScreen} edges={["top", "bottom"]}>
        <Text style={styles.permText}>
          Camera access is needed to take photos.
        </Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.permBtn, styles.cancelBtn]}
          onPress={() => router.back()}
        >
          <Text style={styles.permBtnText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />

      {/* Top bar */}
      <SafeAreaView edges={["top"]} style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          disabled={saving}
          hitSlop={theme.layout.hitSlop.medium}
          style={styles.topBtn}
        >
          <MaterialCommunityIcons name="close" size={26} color="#fff" />
        </TouchableOpacity>

        {capturedUris.length > 0 && (
          <TouchableOpacity
            onPress={handleDone}
            disabled={saving || capturing}
            style={styles.doneBtn}
          >
            {saving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.doneBtnText}>
                Done ({capturedUris.length})
              </Text>
            )}
          </TouchableOpacity>
        )}
      </SafeAreaView>

      {/* Thumbnail strip — most recent on left */}
      {capturedUris.length > 0 && (
        <View style={styles.stripContainer}>
          <FlatList
            horizontal
            data={capturedUris}
            keyExtractor={(uri, i) => `${uri}-${i}`}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stripContent}
            renderItem={({ item }) => (
              <Image source={{ uri: item }} style={styles.stripThumb} />
            )}
          />
        </View>
      )}

      {/* Shutter */}
      <SafeAreaView edges={["bottom"]} style={styles.shutterArea}>
        <TouchableOpacity
          onPress={handleCapture}
          disabled={capturing || saving}
          activeOpacity={0.7}
          style={styles.shutterOuter}
        >
          <View
            style={[styles.shutterInner, capturing && styles.shutterActive]}
          />
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#000" },
  container: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },

  permScreen: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.m,
  },
  permText: {
    ...theme.typography.body,
    color: "#fff",
    textAlign: "center",
    marginHorizontal: theme.spacing.l,
    marginBottom: theme.spacing.s,
  },
  permBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.l,
    paddingVertical: theme.spacing.s,
    borderRadius: theme.layout.borderRadius.m,
  },
  cancelBtn: { backgroundColor: "rgba(255,255,255,0.15)" },
  permBtnText: { ...theme.typography.bodyBold, color: "#fff" },

  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
  },
  topBtn: {
    padding: theme.spacing.xs,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: theme.layout.borderRadius.m,
  },
  doneBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.m,
    minWidth: 90,
    alignItems: "center",
  },
  doneBtnText: { ...theme.typography.bodyBold, color: "#fff" },

  stripContainer: {
    position: "absolute",
    bottom: 110,
    left: 0,
    right: 0,
    height: 72,
    justifyContent: "center",
  },
  stripContent: {
    paddingHorizontal: theme.spacing.m,
    gap: theme.spacing.xs,
    flexDirection: "row",
  },
  stripThumb: {
    width: 64,
    height: 64,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.5)",
  },

  shutterArea: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingBottom: theme.spacing.l,
    paddingTop: theme.spacing.s,
  },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "#fff",
  },
  shutterActive: { opacity: 0.4 },
});
