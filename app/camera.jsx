import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { CameraView, useCameraPermissions } from "expo-camera";
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
import { addInspectionPhoto } from "../db/inspectionForm";
import { logError } from "../db/logs";

export default function CameraScreen() {
  const router = useRouter();
  const { sectionSk } = useLocalSearchParams();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // Each entry: { tempUri }. The temp URI drives the thumbnail strip;
  // handleDone processes each capture into the app's photo cache (downscale +
  // JPEG) — nothing is written to the user's Photos library.
  const [captured, setCaptured] = useState([]);
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
      setCaptured((prev) => [{ tempUri: photo.uri }, ...prev]);
    } catch (e) {
      logError(e, "CameraScreen.handleCapture");
    } finally {
      setCapturing(false);
    }
  }

  async function handleDone() {
    if (captured.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      // Reverse so DB insertion order matches capture order (most recent last).
      const ordered = [...captured].reverse();
      for (const item of ordered) {
        await addInspectionPhoto({
          descriptionSk: sectionSk,
          sourceUri: item.tempUri,
        });
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

        {captured.length > 0 && (
          <TouchableOpacity
            onPress={handleDone}
            disabled={saving || capturing}
            style={styles.doneBtn}
          >
            {saving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.doneBtnText}>Done ({captured.length})</Text>
            )}
          </TouchableOpacity>
        )}
      </SafeAreaView>

      {/* Thumbnail strip — most recent on left */}
      {captured.length > 0 && (
        <View style={styles.stripContainer}>
          <FlatList
            horizontal
            data={captured}
            keyExtractor={(item, i) => `${item.tempUri}-${i}`}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stripContent}
            renderItem={({ item }) => (
              <Image source={{ uri: item.tempUri }} style={styles.stripThumb} />
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
