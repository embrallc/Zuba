import { theme } from "@theme";
import { Stack } from "expo-router";
import {
  configureReanimatedLogger,
  ReanimatedLogLevel,
} from "react-native-reanimated";

// Suppress strict-mode warning triggered by third-party libraries (e.g. calendar-kit)
// reading shared value `.value` during render — not a bug in our code.
configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false });
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initializeDatabase } from "../db/index";
import { getAllInspections } from "../db/inspections";
import { logError } from "../db/logs";
import { getOrCreateUser } from "../db/users";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const loadInspections = useInspectionStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const setUserSk = useSettingsStore((s) => s.setUserSk);

  useEffect(() => {
    async function init() {
      try {
        initializeDatabase();
        const userSk = await getOrCreateUser();
        setUserSk(userSk);
        await loadSettings();
        const inspections = await getAllInspections();
        loadInspections(inspections);
      } catch (e) {
        logError(e, "RootLayout.init");
      } finally {
        // Always mark ready so the app renders instead of hanging on the spinner
        setReady(true);
      }
    }
    init();
  }, []);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.colors.mainBackground,
        }}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar
        style="dark"
        translucent={false}
        backgroundColor="transparent"
      />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="addinspection"
          options={{ headerShown: false, presentation: "modal" }}
        />
        <Stack.Screen
          name="monthtooltip"
          options={{ headerShown: false, presentation: "modal" }}
        />
        <Stack.Screen
          name="settings"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="map"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="inspectionform"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="photoedit"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="camera"
          options={{ headerShown: false, animation: "slide_from_bottom" }}
        />
        <Stack.Screen
          name="sectiontemplates"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="photonote"
          options={{
            headerShown: false,
            presentation: "transparentModal",
            animation: "slide_from_bottom",
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
