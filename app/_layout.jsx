import { theme } from "@theme";
import { router, Stack } from "expo-router";
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
import { getSmsTemplates } from "../db/smsTemplates";
import { getOrCreateUser } from "../db/users";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useSmsStore } from "../stores/useSmsStore";
import { supabase } from "../utils/supabase";

// ── RevenueCat (pending Apple Developer approval) ─────────────────────────────
// import { useSubscriptionStore } from "../stores/useSubscriptionStore";
// import {
//   addCustomerInfoListener,
//   configurePurchases,
//   fetchCustomerInfo,
// } from "../utils/purchases";
// ─────────────────────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);
  const loadInspections = useInspectionStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const setUserSk = useSettingsStore((s) => s.setUserSk);
  const loadSmsTemplates = useSmsStore((s) => s.load);

  // ── RevenueCat (pending Apple Developer approval) ───────────────────────────
  // const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);
  // ───────────────────────────────────────────────────────────────────────────

  async function loadUserData(supabaseUid) {
    const userSk = await getOrCreateUser(supabaseUid);
    setUserSk(userSk);
    await loadSettings();
    const inspections = await getAllInspections();
    loadInspections(inspections);
    try {
      const smsTemplates = await getSmsTemplates(userSk);
      loadSmsTemplates(smsTemplates);
    } catch (smsErr) {
      logError(smsErr, "RootLayout.loadUserData.sms");
    }
    // ── RevenueCat (pending Apple Developer approval) ───────────────────────
    // try {
    //   const customerInfo = await fetchCustomerInfo();
    //   setCustomerInfo(customerInfo);
    // } catch (purchasesErr) {
    //   logError(purchasesErr, "RootLayout.loadUserData.purchases");
    // }
    // ────────────────────────────────────────────────────────────────────────
  }

  useEffect(() => {
    // ── RevenueCat (pending Apple Developer approval) ─────────────────────────
    // configurePurchases();
    // const purchasesListener = addCustomerInfoListener((info) => {
    //   setCustomerInfo(info);
    // });
    // ─────────────────────────────────────────────────────────────────────────

    initializeDatabase();

    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setIsAuthed(!!session);
        if (event === "SIGNED_IN") {
          try {
            await loadUserData(session.user.id);
          } catch (e) {
            logError(e, "RootLayout.onAuthStateChange.loadUserData");
          }
        }
      },
    );

    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        console.log("[init] getSession result:", session ? `uid=${session.user?.id} expires_at=${session.expires_at}` : "null");
        setIsAuthed(!!session);
        if (session) {
          await loadUserData(session.user.id);
        }
      } catch (e) {
        logError(e, "RootLayout.init");
      } finally {
        setReady(true);
      }
    }
    init();

    return () => {
      authSubscription.unsubscribe();
      // ── RevenueCat (pending Apple Developer approval) ─────────────────────
      // purchasesListener.remove();
      // ─────────────────────────────────────────────────────────────────────
    };
  }, []);

  // Guard: once we know the auth state, force the correct screen.
  // expo-router persists navigation state in dev, so initialRouteName alone
  // isn't enough — an unauthenticated reload would restore the tabs screen.
  useEffect(() => {
    if (!ready) return;
    if (!isAuthed) router.replace("/login");
  }, [ready, isAuthed]);

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
      <Stack initialRouteName={isAuthed ? "(tabs)" : "login"}>
        <Stack.Screen name="login" options={{ headerShown: false, animation: "none" }} />
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
          name="smstemplates"
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
