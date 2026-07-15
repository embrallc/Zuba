import { theme } from "@theme";
import * as Notifications from "expo-notifications";
import { router, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  configureReanimatedLogger,
  ReanimatedLogLevel,
} from "react-native-reanimated";
import AppErrorBoundary from "../components/AppErrorBoundary";
import TopBanner from "../components/TopBanner";
import { DB_EVENTS, subscribe } from "../db/events";
import { initializeDatabase } from "../db/index";
import { getAllInspections } from "../db/inspections";
import { logError } from "../db/logs";
import { getOrgPaymentStatus } from "../db/organizations";
import { getSmsTemplates } from "../db/smsTemplates";
import { getLocalUser, getOrCreateUser, pullSelfUser } from "../db/users";
import { useCalendarStore } from "../stores/useCalendarStore";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useSmsStore } from "../stores/useSmsStore";
import { runPull, startCalendarSync } from "../utils/calendarSync";
import {
  startConnectivityWatch,
  stopConnectivityWatch,
} from "../utils/connectivity";
import { startLogShipper, stopLogShipper } from "../utils/logShipper";
import {
  startInspectionRealtime,
  stopInspectionRealtime,
} from "../utils/inspectionRealtime";
import { setupGlobalErrorHandler } from "../utils/globalErrorHandler";
import {
  cancelUpcomingApptNotif,
  getUpcomingApptTapRoute,
  scheduleUpcomingApptNotif,
} from "../utils/notifications";
import { supabase } from "../utils/supabase";
import { syncAll } from "../utils/sync";

// Suppress strict-mode warning triggered by third-party libraries (e.g. calendar-kit)
// reading shared value `.value` during render — not a bug in our code.
configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false });

// Install the global error/rejection capture as early as possible (module load,
// before the component mounts) so any boot-time failure is printed + logged.
setupGlobalErrorHandler();

import { isLocked, useSubscriptionStore } from "../stores/useSubscriptionStore";
import {
  addCustomerInfoListener,
  configurePurchases,
  fetchCustomerInfo,
  logInPurchases,
} from "../utils/purchases";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);
  const pathname = usePathname();
  const loadInspections = useInspectionStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadNotificationsFromDb = useSettingsStore(
    (s) => s.loadNotificationsFromDb,
  );
  const setUserSk = useSettingsStore((s) => s.setUserSk);
  const setUserProfile = useSettingsStore((s) => s.setUserProfile);
  const setOrgSk = useSettingsStore((s) => s.setOrgSk);
  const setPaymentsLive = useSettingsStore((s) => s.setPaymentsLive);
  const setAutoSendInvoice = useSettingsStore((s) => s.setAutoSendInvoice);
  const setFname = useSettingsStore((s) => s.setFname);
  const setLname = useSettingsStore((s) => s.setLname);
  const loadSmsTemplates = useSmsStore((s) => s.load);

  const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);
  const subscriptionStatus = useSubscriptionStore((s) => s.status);
  const hydrateSubscription = useSubscriptionStore((s) => s.hydrate);
  const refreshSubscription = useSubscriptionStore((s) => s.refreshStatus);

  async function loadUserData(supabaseUid, sessionUser) {
    initializeDatabase(supabaseUid);
    const orgSk = sessionUser?.user_metadata?.org_sk ?? null;
    const userProfile = sessionUser?.user_metadata?.user_profile ?? null;
    const userSk = await getOrCreateUser(supabaseUid, orgSk, userProfile);
    setUserSk(userSk);
    setUserProfile(userProfile);
    setOrgSk(orgSk);

    // Seed name/profile from the LOCAL Users row so the UI renders instantly
    // without waiting on the network.
    const localUser = await getLocalUser(userSk);
    if (localUser) {
      setFname(localUser.fname ?? null);
      setLname(localUser.lname ?? null);
      if (localUser.UserProfile) setUserProfile(localUser.UserProfile);
    }

    // Reconcile from the cloud in the background — never blocks boot.
    // pullSelfUser writes back into local SQLite; we also update the store
    // here so any open screens reflect the fresh values as soon as they
    // arrive.
    pullSelfUser(userSk)
      .then((cloud) => {
        if (!cloud) return;
        setFname(cloud.fname ?? null);
        setLname(cloud.lname ?? null);
        if (cloud.user_profile) setUserProfile(cloud.user_profile);
        if (cloud.org_sk) setOrgSk(cloud.org_sk);
      })
      .catch((e) => logError(e, "RootLayout.pullSelfUser"));

    // Cache whether invoicing is live for this org (organizations.stripe_charges_enabled).
    // Background, never blocks boot; drives the invoice-button visibility + upsell.
    // Any org member may read it (org SELECT RLS is role-agnostic).
    if (orgSk) {
      getOrgPaymentStatus(orgSk)
        .then((s) => {
          setPaymentsLive(!!s?.stripe_charges_enabled);
          setAutoSendInvoice(!!s?.auto_send_invoice);
        })
        .catch((e) => logError(e, "RootLayout.loadUserData.paymentStatus"));
    }

    await loadSettings();
    // Device-local calendar-sync config (mints a stable deviceId on first run).
    // MUST NOT block inspection loading — wrap so a calendar-config failure can
    // never abort the rest of boot (schedule + sync).
    try {
      await useCalendarStore.getState().load();
    } catch (calErr) {
      logError(calErr, "RootLayout.loadUserData.calendarConfig");
    }
    // SQLite is the source of truth for notification toggles — overwrite the
    // AsyncStorage-hydrated map with whatever loadSettings just put in place.
    await loadNotificationsFromDb(userSk);
    const inspections = await getAllInspections();
    loadInspections(inspections);
    try {
      const smsTemplates = await getSmsTemplates(userSk);
      loadSmsTemplates(smsTemplates);
    } catch (smsErr) {
      logError(smsErr, "RootLayout.loadUserData.sms");
    }
    // RevenueCat identity must match the Supabase uid BEFORE any paywall —
    // it's how the webhook maps a purchase back to this org. The server
    // status check runs in the background: the persisted verdict from
    // hydrate() gates the boot instantly, and the fresh verdict re-routes
    // when it lands.
    try {
      const customerInfo = await logInPurchases(supabaseUid);
      if (customerInfo) setCustomerInfo(customerInfo);
    } catch (purchasesErr) {
      logError(purchasesErr, "RootLayout.loadUserData.purchases");
    }
    refreshSubscription().catch((e) =>
      logError(e, "RootLayout.loadUserData.subscriptionStatus"),
    );
  }

  useEffect(() => {
    configurePurchases();
    // Watch connectivity so a reconnect immediately flushes the dirty queue.
    startConnectivityWatch();
    // Batch-ship buffered logs/telemetry to the cloud app_logs table.
    startLogShipper();
    const removePurchasesListener = addCustomerInfoListener((info) => {
      setCustomerInfo(info);
    });
    hydrateSubscription().catch((e) =>
      logError(e, "RootLayout.hydrateSubscription"),
    );

    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      setIsAuthed(!!session);
      if (event === "SIGNED_IN" && session?.user?.id) {
        try {
          await loadUserData(session.user.id, session.user);
          syncAll()
            .then(async () =>
              loadInspections((await getAllInspections()) ?? []),
            )
            .catch((e) => logError(e, "RootLayout.syncAll"));
        } catch (e) {
          logError(e, "RootLayout.onAuthStateChange.loadUserData");
        }
      }
    });

    async function init() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        console.log(
          "[init] getSession result:",
          session
            ? `uid=${session.user?.id} expires_at=${session.expires_at}`
            : "null",
        );
        setIsAuthed(!!session);
        if (session?.user?.id) {
          await loadUserData(session.user.id, session.user);
          syncAll()
            .then(async () =>
              loadInspections((await getAllInspections()) ?? []),
            )
            .catch((e) => logError(e, "RootLayout.syncAll"));
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
      removePurchasesListener?.();
      stopConnectivityWatch();
      stopLogShipper();
    };
  }, []);

  // Guard: once we know the auth state, force the correct screen.
  // expo-router persists navigation state in dev, so initialRouteName alone
  // isn't enough — an unauthenticated reload would restore the tabs screen.
  useEffect(() => {
    if (!ready) return;
    if (!isAuthed) {
      router.replace("/login");
      return;
    }
    // Subscription gate. isLocked() trusts the SERVER verdict (persisted
    // across launches); the only local inference is "the trial end the
    // server reported has now passed". Unlock is symmetric: the moment a
    // fresh status clears, the lock screen routes back into the app.
    const locked = isLocked(subscriptionStatus);
    if (locked && pathname !== "/locked") {
      router.replace("/locked");
    } else if (!locked && pathname === "/locked") {
      router.replace("/(tabs)");
    }
  }, [ready, isAuthed, subscriptionStatus, pathname]);

  // Re-verify whenever the app returns to the foreground — catches trial
  // expiry / renewals / seat changes that happened while backgrounded.
  useEffect(() => {
    if (!ready || !isAuthed) return;
    // Initial catch-up pull on entering the authed app (config is loaded by
    // loadUserData before `ready` flips true). Cheap no-op when sync is off.
    runPull().catch((e) => logError(e, "RootLayout.initialCalendarPull"));

    // Live cancellation channel + the unread-cancellation badge. Recompute the
    // count from SQLite and play the attention bounce on app-enter.
    startInspectionRealtime();
    const settings = useSettingsStore.getState();
    settings.refreshCancelledCount?.();
    settings.bumpCancelBadgePulse?.();
    // Pull global product announcements + recompute their unread badge.
    settings.refreshProductNotifs?.();

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshSubscription().catch((e) =>
          logError(e, "RootLayout.foregroundSubscriptionRefresh"),
        );
        // Calendar has no change-notification API — poll for events an
        // assistant added/edited/deleted while we were backgrounded. Self-gates
        // on the calendar config, so this is a cheap no-op when sync is off.
        runPull().catch((e) => logError(e, "RootLayout.foregroundCalendarPull"));
        // Refresh + re-pulse the cancellation badge on every foreground.
        const s = useSettingsStore.getState();
        s.refreshCancelledCount?.();
        s.bumpCancelBadgePulse?.();
        s.refreshProductNotifs?.();
      }
    });
    return () => {
      sub.remove();
      stopInspectionRealtime();
    };
  }, [ready, isAuthed]);

  // Wire db-layer events to the notification scheduler. db/inspections.js
  // emits on insert/update/delete; we react by scheduling or cancelling a
  // local reminder. Keeps the db module decoupled from the notifications
  // module — both sides only know about the event names in db/events.js.
  //
  // Mount once at app start (not gated on auth) so cancellations still fire
  // for unauthenticated cleanup paths. The scheduler itself is gated on
  // permission + master-toggle internally, so listening eagerly is safe.
  useEffect(() => {
    const handleInsertOrUpdate = (inspection) => {
      scheduleUpcomingApptNotif({ inspection });
      // Keep the unread-cancellation badge in sync after any inspection change
      // (a pulled/realtime cancel, or a restore from the Cancelled archive).
      useSettingsStore.getState().refreshCancelledCount?.();
    };
    const handleDelete = (payload) => {
      cancelUpcomingApptNotif(payload?.InspectionSk);
    };
    const unsubInsert = subscribe(
      DB_EVENTS.INSPECTION_INSERTED,
      handleInsertOrUpdate,
    );
    const unsubUpdate = subscribe(
      DB_EVENTS.INSPECTION_UPDATED,
      handleInsertOrUpdate,
    );
    const unsubDelete = subscribe(DB_EVENTS.INSPECTION_DELETED, handleDelete);
    return () => {
      unsubInsert();
      unsubUpdate();
      unsubDelete();
    };
  }, []);

  // Wire db-layer events to the calendar sync engine (Zanbi → calendar). Like
  // the notification subscriber, mount once and let the engine self-gate on the
  // calendar config (enabled / push / chosen calendar). The matching
  // calendar → Zanbi direction is the foreground poll (runPull) above.
  useEffect(() => {
    const stop = startCalendarSync();
    return stop;
  }, []);

  // Notification tap routing. Two paths handled here:
  //   1. Live tap while the app is open / backgrounded — covered by
  //      addNotificationResponseReceivedListener.
  //   2. Cold-start tap that woke the app from killed state — covered by
  //      getLastNotificationResponseAsync (one-shot read on mount).
  // Both funnel through getUpcomingApptTapRoute, which validates the data
  // payload and returns a navigation descriptor (or null to ignore).
  useEffect(() => {
    if (!ready || !isAuthed) return;

    function handleResponse(response) {
      const route = getUpcomingApptTapRoute(response);
      if (!route) return;
      try {
        router.navigate(route);
      } catch (e) {
        logError(e, "RootLayout.notificationResponse.navigate");
      }
    }

    // 1. Live taps.
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        try {
          handleResponse(response);
        } catch (e) {
          logError(e, "RootLayout.notificationResponse.live");
        }
      },
    );

    // 2. Cold-start tap. Use a tiny delay so router has fully mounted the
    // tabs stack before we push onto it.
    let coldStartTimer = null;
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        coldStartTimer = setTimeout(() => handleResponse(response), 250);
      })
      .catch((e) => logError(e, "RootLayout.notificationResponse.coldStart"));

    return () => {
      sub.remove();
      if (coldStartTimer) clearTimeout(coldStartTimer);
    };
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
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar
        style="dark"
        translucent={false}
        backgroundColor="transparent"
      />
      <Stack initialRouteName={isAuthed ? "(tabs)" : "login"}>
        <Stack.Screen
          name="login"
          options={{ headerShown: false, animation: "none" }}
        />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="locked"
          options={{
            headerShown: false,
            animation: "fade",
            gestureEnabled: false,
          }}
        />
        <Stack.Screen
          name="addinspection"
          options={{ headerShown: false, presentation: "modal" }}
        />
        <Stack.Screen
          name="settings"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="payments-settings"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="autodocsend"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="payments"
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
          name="smstemplates"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="notifications"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="feedback"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="announcements"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="calendarsettings"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="manageusers"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="approvals"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="unassigned"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="allinspections"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="archive"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="reportviewer"
          options={{ headerShown: false, animation: "slide_from_right" }}
        />
      </Stack>
      {/* Global drop-down notification banner. Sits above every screen so
          any module can call showBanner(...) without per-screen wiring. */}
      <TopBanner />
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
