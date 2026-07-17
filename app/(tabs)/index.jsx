import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { MotiView } from "moti";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import InspectionCard from "../../components/InspectionCard";
import MyDayDashboard from "../../components/MyDayDashboard";
import NotificationBadge from "../../components/NotificationBadge";
import { runDevQuery } from "../../db/devQuery";
import { DB_EVENTS, subscribe } from "../../db/events";
import {
  getAllInspections,
  isInspectionLocallyRetired,
} from "../../db/inspections";
import { logError } from "../../db/logs";
import { useDebouncedPress } from "../../hooks/useDebouncedPress";
import { useMyDayRoute } from "../../hooks/useMyDayRoute";
import { useSettingsBadgeTotal } from "../../hooks/useSettingsBadges";
import { useInspectionStore } from "../../stores/useInspectionStore";
import { useMapStore } from "../../stores/useMapStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { isOnline } from "../../utils/connectivity";
import { syncAll } from "../../utils/sync";

const FAB_SIZE = (theme?.layout?.iconSize?.l ?? 28) * 2;

const SEARCH_FIELDS = [
  "FullName",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "ZipCode",
];

export default function MyDayScreen() {
  const [pulseKey, setPulseKey] = useState(0);
  const [query, setQuery] = useState("");

  // Notification tap or any other deep link can hand us `?q=<full name>` to
  // pre-fill the search bar. Sync once per param change so a manual edit
  // afterwards is not stomped on.
  const params = useLocalSearchParams();
  useEffect(() => {
    const incoming =
      typeof params?.q === "string"
        ? params.q
        : Array.isArray(params?.q)
          ? params.q[0]
          : "";
    if (incoming && incoming !== query) {
      setQuery(incoming);
    }
    // Intentionally only depend on the incoming param; we don't want every
    // user keystroke to re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.q]);

  useFocusEffect(
    useCallback(() => {
      setPulseKey((k) => k + 1);
    }, []),
  );

  const router = useRouter();
  const sortedIds = useInspectionStore((s) => s.sortedIds);
  const inspections = useInspectionStore((s) => s.inspections);
  const loadInspections = useInspectionStore((s) => s.load);
  const openGlobal = useMapStore((s) => s.openGlobal);
  // Aggregate red badge over the Settings (menu) button: every unviewed
  // Settings notification (cancellations + pending seat approvals).
  const badgeTotal = useSettingsBadgeTotal();
  const cancelPulse = useSettingsStore((s) => s.cancelBadgePulseKey);

  // My Day dashboard data. Fetches on mount; the hook handles location
  // permission, error banners, and inflight de-dupe.
  const {
    data: routeData,
    loading: routeLoading,
    error: routeError,
    refresh: refreshRoute,
  } = useMyDayRoute();

  // Reconcile a "ghost" Up Next. The my-day-route EF is cloud-authoritative, so
  // if an inspection was deleted locally but its soft-delete hasn't reached the
  // cloud yet (deleted → logged out before sync, or a transient network drop),
  // the EF still returns it as the next stop after re-login. Detect that — the
  // local DB knows the row is _deleted/terminal — then push the pending delete
  // (syncAll) and re-fetch so the EF drops it. We hide the stale tile meanwhile.
  // One attempt per SK guards against a refetch loop if the delete can't push
  // (offline); pull-to-refresh resolves it once connectivity returns.
  const [staleStopSk, setStaleStopSk] = useState(null);
  const reconciledStopsRef = useRef(new Set());
  useEffect(() => {
    const sk = routeData?.nextStop?.inspectionSk;
    if (!sk || reconciledStopsRef.current.has(sk)) return;
    let cancelled = false;
    (async () => {
      const retired = await isInspectionLocallyRetired(sk).catch(() => false);
      if (cancelled || !retired) return;
      reconciledStopsRef.current.add(sk);
      setStaleStopSk(sk);
      try {
        await syncAll(); // push the pending soft-delete to the cloud
        await refreshRoute(); // EF recomputes without it
      } catch (e) {
        logError(e, "MyDayScreen.reconcileStaleNextStop");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeData?.nextStop?.inspectionSk, refreshRoute]);

  // While a locally-deleted stop is still what the EF is returning, show the
  // skeleton instead of the ghost inspection.
  const staleNextStop =
    !!routeData?.nextStop?.inspectionSk &&
    routeData.nextStop.inspectionSk === staleStopSk;

  // Full day reconcile: push local changes + pull cloud-side ones, reload the
  // local list, then refresh the dashboard route (cache-aware — only hits Google
  // Routes if the fingerprint or TTL invalidates). Shared by pull-to-refresh and
  // the automatic on-change refresh below.
  const reconcileDay = useCallback(async () => {
    // Local list first — always works offline, and refreshing the inspections
    // list is what pull-to-refresh is really for.
    const fresh = await getAllInspections();
    loadInspections(fresh ?? []);
    // Network parts only when online (NetInfo-backed). Offline this skips
    // cleanly — the local list above is already refreshed.
    if (!isOnline()) return;
    await syncAll();
    await refreshRoute();
  }, [loadInspections, refreshRoute]);

  // Pull-to-refresh.
  const [refreshing, setRefreshing] = useState(false);
  async function handlePullRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await reconcileDay();
    } catch (e) {
      logError(e, "MyDayScreen.handlePullRefresh");
    } finally {
      setRefreshing(false);
    }
  }

  // Keep "Up Next" honest without a manual pull. Completing / deleting /
  // rescheduling an inspection mutates the DB and emits on the bus (the same bus
  // notifications + calendar sync react to). The route is computed cloud-side by
  // the my-day-route EF, so we reconcile — push the change, then refetch — and
  // the completed stop drops out while the next one rolls in (or the card clears
  // to "done"). While focused we refresh live (debounced so a burst of edits
  // coalesces into one sync); while blurred we only mark the day dirty and
  // reconcile once on refocus, so edits on OTHER screens don't burn a background
  // GPS fix / EF call.
  const focusedRef = useRef(false);
  const dayDirtyRef = useRef(false);
  useEffect(() => {
    let timer = null;
    const onInspectionChange = () => {
      if (!focusedRef.current) {
        dayDirtyRef.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        reconcileDay().catch((e) => logError(e, "MyDayScreen.autoReconcile"));
      }, 800);
    };
    const unsubs = [
      subscribe(DB_EVENTS.INSPECTION_INSERTED, onInspectionChange),
      subscribe(DB_EVENTS.INSPECTION_UPDATED, onInspectionChange),
      subscribe(DB_EVENTS.INSPECTION_DELETED, onInspectionChange),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [reconcileDay]);

  // Track focus for the live refresh above, and flush a pending reconcile when
  // returning to this tab (e.g. an inspection completed from another screen).
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (dayDirtyRef.current) {
        dayDirtyRef.current = false;
        reconcileDay().catch((e) => logError(e, "MyDayScreen.focusReconcile"));
      }
      return () => {
        focusedRef.current = false;
      };
    }, [reconcileDay]),
  );

  const todayInspections = useMemo(() => {
    const today = dayjs().format("YYYY-MM-DD");
    return sortedIds
      .map((id) => inspections[id])
      .filter(
        (i) =>
          i &&
          i.ScheduledAt &&
          dayjs(i.ScheduledAt).format("YYYY-MM-DD") === today,
      );
  }, [sortedIds, inspections]);

  const filtered = useMemo(() => {
    if (!query.trim()) return todayInspections;
    const lower = query.toLowerCase();
    return todayInspections.filter((i) =>
      SEARCH_FIELDS.some((f) => i[f]?.toLowerCase().includes(lower)),
    );
  }, [todayInspections, query]);

  const handleOpenMap = useDebouncedPress(() => {
    try {
      openGlobal();
      router.push("/map");
    } catch (e) {
      logError(e, "MyDayScreen.handleOpenMap");
    }
  });

  const handleSettings = useDebouncedPress(() => {
    try {
      router.push("/settings");
    } catch (e) {
      logError(e, "MyDayScreen.handleSettings");
    }
  });

  const handleAdd = useDebouncedPress(() => {
    try {
      router.push("/addinspection");
    } catch (e) {
      logError(e, "MyDayScreen.handleAdd");
    }
  });

  const handleCardPress = useDebouncedPress((inspection) => {
    try {
      router.push({
        pathname: "/addinspection",
        params: { inspectionSk: inspection.InspectionSk },
      });
    } catch (e) {
      logError(e, "MyDayScreen.handleCardPress");
    }
  });

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.searchRow}>
          <View style={styles.searchContainer}>
            <MaterialCommunityIcons
              name="magnify"
              size={theme.layout.iconSize.m}
              color={theme.colors.icon}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search today's inspections..."
              placeholderTextColor={theme.colors.textFine}
              value={query}
              onChangeText={setQuery}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
          </View>

          <TouchableOpacity
            onPress={handleOpenMap}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.headerBtn}
          >
            <MaterialCommunityIcons
              name="map-outline"
              size={theme.layout.iconSize.l}
              color={theme.colors.primary}
            />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSettings}
            onLongPress={__DEV__ ? runDevQuery : undefined}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.headerBtn}
          >
            <MaterialCommunityIcons
              name="menu"
              size={theme.layout.iconSize.l}
              color={theme.colors.icon}
            />
            <NotificationBadge
              count={badgeTotal}
              pulse={cancelPulse}
              style={styles.menuBadge}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Dashboard — top 3/5 */}
      <View style={styles.dashboardSection}>
        <MyDayDashboard
          data={staleNextStop ? null : routeData}
          loading={routeLoading || staleNextStop}
          error={routeError}
          onRefresh={refreshRoute}
        />
      </View>

      {/* Today's inspections — bottom 2/5 */}
      <View style={styles.listSection}>
        <View style={styles.listSectionHeader}>
          <MaterialCommunityIcons
            name="calendar-today"
            size={theme.layout.iconSize.s}
            color={theme.colors.textSubtle}
          />
          <Text style={styles.listSectionTitle}>Today's Inspections</Text>
          <View style={styles.listSectionCountBubble}>
            <Text style={styles.listSectionCount}>{filtered.length}</Text>
          </View>
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.InspectionSk}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handlePullRefresh}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
          renderItem={({ item, index }) => (
            <Animated.View
              entering={FadeInDown.delay(Math.min(index * 55, 220))
                .duration(380)
                .springify()
                .damping(16)}
            >
              <InspectionCard
                inspection={item}
                onPress={() => handleCardPress(item)}
              />
            </Animated.View>
          )}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons
                name="calendar-blank-outline"
                size={theme.layout.iconSize.l}
                color={theme.colors.textFine}
              />
              <Text style={styles.emptyText}>
                {query
                  ? "No inspections match your search."
                  : "No inspections scheduled for today."}
              </Text>
            </View>
          }
        />
      </View>

      {/* Floating action button with pulse ring */}
      <View style={styles.fabContainer}>
        <MotiView
          key={pulseKey}
          from={{ opacity: 0.5, scale: 1 }}
          animate={{ opacity: 0, scale: 1.65 }}
          transition={{
            type: "timing",
            duration: 1600,
            loop: true,
            repeatReverse: false,
          }}
          style={[
            StyleSheet.absoluteFillObject,
            {
              borderRadius: FAB_SIZE / 2,
              backgroundColor: theme.colors.primary,
            },
          ]}
        />
        <TouchableOpacity
          style={styles.fab}
          onPress={handleAdd}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons
            name="plus"
            size={FAB_SIZE * 0.55}
            color="#fff"
          />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
  },

  header: {
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    ...theme.shadows.light,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
  },
  searchContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.input,
    borderRadius: theme.layout.borderRadius.full,
    paddingHorizontal: theme.spacing.s,
    height: 38,
  },
  searchIcon: {
    marginRight: theme.spacing.xs,
  },
  searchInput: {
    flex: 1,
    ...theme.typography.body,
    paddingVertical: 0,
  },
  headerBtn: {
    padding: theme.spacing.xs,
  },
  menuBadge: {
    position: "absolute",
    top: -2,
    right: -2,
  },

  // Dashboard section — top 3/5
  dashboardSection: {
    flex: 3,
    paddingTop: theme.spacing.m,
    paddingHorizontal: theme.spacing.m,
    paddingBottom: 12,
  },
  dashboardCard: {
    flex: 1,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.s,
    ...theme.shadows.medium,
  },
  dashboardIcon: {
    marginBottom: theme.spacing.xs,
  },
  dashboardTitle: {
    ...theme.typography.h2,
    color: theme.colors.text,
  },
  dashboardSub: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
  },
  dashboardComingSoon: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    marginTop: theme.spacing.xs,
  },

  // List section — bottom 2/5
  listSection: {
    flex: 2,
  },
  listSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
  },
  listSectionTitle: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    flex: 1,
  },
  listSectionCountBubble: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: theme.colors.cardBackground,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.light,
  },
  listSectionCount: {
    ...theme.typography.caption,
    color: theme.colors.primary,
    fontWeight: "700",
    textAlign: "center",
  },
  list: {
    paddingTop: theme.spacing.xs,
    paddingBottom: FAB_SIZE + 48,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing.xl,
    gap: theme.spacing.s,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    paddingHorizontal: theme.spacing.xl,
  },

  // FAB
  fabContainer: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: FAB_SIZE,
    height: FAB_SIZE,
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.medium,
  },
});
