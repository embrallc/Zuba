import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useFocusEffect, useRouter } from "expo-router";
import { MotiView } from "moti";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import InspectionCard from "../../components/InspectionCard";
import NotificationBadge from "../../components/NotificationBadge";
import { runDevQuery } from "../../db/devQuery";
import { getAllLogs, logError } from "../../db/logs";
import { useDebouncedPress } from "../../hooks/useDebouncedPress";
import { useInspectionStore } from "../../stores/useInspectionStore";
import { useMapStore } from "../../stores/useMapStore";
import { useSettingsStore } from "../../stores/useSettingsStore";

const SEARCH_FIELDS = [
  "FullName",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "ZipCode",
];

const FAB_SIZE = (theme?.layout?.iconSize?.l ?? 28) * 2;

export default function InspectionsScreen() {
  const [query, setQuery] = useState("");
  const [pulseKey, setPulseKey] = useState(0);

  // Unread-cancellation badge over the menu (settings) button — same store
  // fields the My Day + Settings badges use, so all three stay in lockstep.
  const cancelCount = useSettingsStore((s) => s.unviewedCancelledCount);
  const cancelPulse = useSettingsStore((s) => s.cancelBadgePulseKey);
  const refreshCancelledCount = useSettingsStore((s) => s.refreshCancelledCount);
  const bumpCancelBadgePulse = useSettingsStore((s) => s.bumpCancelBadgePulse);

  useFocusEffect(
    useCallback(() => {
      setPulseKey((k) => k + 1);
      // Recompute the count + replay the bounce whenever this screen is entered,
      // so switching to it with unviewed cancellations draws attention.
      refreshCancelledCount?.();
      bumpCancelBadgePulse?.();
    }, [refreshCancelledCount, bumpCancelBadgePulse]),
  );
  const router = useRouter();
  const sortedIds = useInspectionStore((s) => s.sortedIds);
  const inspections = useInspectionStore((s) => s.inspections);
  const openGlobal = useMapStore((s) => s.openGlobal);

  const sorted = sortedIds.map((id) => inspections[id]).filter(Boolean);

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const lower = query.toLowerCase();
    return sorted.filter((inspection) =>
      SEARCH_FIELDS.some((field) =>
        inspection[field]?.toLowerCase().includes(lower),
      ),
    );
  }, [sorted, query]);

  const handleOpenMap = useDebouncedPress(() => {
    try {
      openGlobal();
      router.push("/map");
    } catch (e) {
      logError(e, "InspectionsScreen.handleOpenMap");
    }
  });

  const handleAdd = useDebouncedPress(() => {
    try {
      router.push("/addinspection");
    } catch (e) {
      logError(e, "InspectionsScreen.handleAdd");
    }
  });

  const handleSettings = useDebouncedPress(() => {
    try {
      router.push("/settings");
    } catch (e) {
      logError(e, "InspectionsScreen.handleSettings");
    }
  });

  const handleCardPress = useDebouncedPress((inspection) => {
    try {
      router.push({
        pathname: "/addinspection",
        params: { inspectionSk: inspection.InspectionSk },
      });
    } catch (e) {
      logError(e, "InspectionsScreen.handleCardPress");
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
              placeholder="Search inspections..."
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
            onLongPress={runDevQuery}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.headerBtn}
          >
            <MaterialCommunityIcons
              name="menu"
              size={theme.layout.iconSize.l}
              color={theme.colors.icon}
            />
            <NotificationBadge
              count={cancelCount}
              pulse={cancelPulse}
              style={styles.menuBadge}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* List */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.InspectionSk}
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
              name="clipboard-text-outline"
              size={theme.layout.iconSize.xl}
              color={theme.colors.textFine}
            />
            <Text style={styles.emptyText}>
              {query
                ? "No inspections match your search."
                : "No inspections yet. Tap + to add one."}
            </Text>
          </View>
        }
      />

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
          onLongPress={() => getAllLogs()}
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
    borderBottomWidth: 0,
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
  list: {
    paddingTop: theme.spacing.s,
    paddingBottom: FAB_SIZE + 48,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing.xxl * 2,
    gap: theme.spacing.m,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    paddingHorizontal: theme.spacing.xl,
  },
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
