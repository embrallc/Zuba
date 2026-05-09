import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useMapStore } from "../stores/useMapStore";
import { useUIStore } from "../stores/useUIStore";

const COMPLETE_FIELDS = [
  "FullName",
  "Phone",
  "Email",
  "AddressLine1",
  "City",
  "State",
  "ZipCode",
  "ScheduledAt",
  "Summary",
];

function isComplete(insp) {
  return COMPLETE_FIELDS.every((f) => !!insp[f]);
}

export default function MonthTooltipScreen() {
  const router = useRouter();
  const selectedDate = useUIStore((s) => s.selectedDate);
  const inspections = useInspectionStore((s) => s.inspections);
  const sortedIds = useInspectionStore((s) => s.sortedIds);
  const openMapForInspection = useMapStore((s) => s.openForInspection);

  const dayInspections = useMemo(
    () =>
      sortedIds
        .map((id) => inspections[id])
        .filter(
          (insp) =>
            insp?.ScheduledAt &&
            dayjs(insp.ScheduledAt).format("YYYY-MM-DD") === selectedDate,
        ),
    [inspections, sortedIds, selectedDate],
  );

  const dateLabel = selectedDate
    ? dayjs(selectedDate).format("dddd, MMMM D")
    : "";

  const handleOpenMap = useCallback(
    (sk) => {
      router.back();
      openMapForInspection(sk);
    },
    [router, openMapForInspection],
  );

  const handleNavigate = useCallback((insp) => {
    const addr = [insp.AddressLine1, insp.City, insp.State, insp.ZipCode]
      .filter(Boolean)
      .join(", ");
    const url =
      Platform.OS === "ios"
        ? `maps://?q=${encodeURIComponent(addr)}`
        : `geo:0,0?q=${encodeURIComponent(addr)}`;
    Linking.openURL(url).catch(() => {});
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Navbar */}
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="close"
            size={theme.layout.iconSize.l}
            color={theme.colors.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle}>{dateLabel}</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      {/* Inspection cards */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {dayInspections.map((insp) => (
          <InspectionTooltipCard
            key={insp.InspectionSk}
            insp={insp}
            onMap={() => handleOpenMap(insp.InspectionSk)}
            onNavigate={() => handleNavigate(insp)}
          />
        ))}
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.footerBtn}
          onPress={() => router.back()}
        >
          <MaterialCommunityIcons
            name="calendar-week"
            size={16}
            color={theme.colors.primary}
          />
          <Text style={styles.footerBtnText}>Go to Week</Text>
        </TouchableOpacity>
        <View style={styles.footerDivider} />
        <TouchableOpacity
          style={styles.footerBtn}
          onPress={() => router.back()}
        >
          <MaterialCommunityIcons
            name="format-list-bulleted"
            size={16}
            color={theme.colors.primary}
          />
          <Text style={styles.footerBtnText}>Go to List</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function InspectionTooltipCard({ insp, onMap, onNavigate }) {
  const router = useRouter();
  const hasCoords = !!(insp.Latitude && insp.Longitude);
  const complete = isComplete(insp);
  const address = [insp.AddressLine1, insp.City, insp.State]
    .filter(Boolean)
    .join(", ");
  const time = insp.ScheduledAt
    ? dayjs(insp.ScheduledAt).format("h:mm A")
    : null;

  return (
    <View style={cardStyles.card}>
      <View
        style={[
          cardStyles.sidebar,
          { backgroundColor: complete ? "#16A34A" : "#D97706" },
        ]}
      />
      <View style={cardStyles.body}>
        <View style={cardStyles.nameRow}>
          <Text style={cardStyles.name} numberOfLines={1}>
            {insp.FullName || "Inspection"}
          </Text>
          {!!time && <Text style={cardStyles.time}>{time}</Text>}
        </View>
        {!!address && (
          <Text style={cardStyles.address} numberOfLines={2}>
            {address}
          </Text>
        )}

        {hasCoords && (
          <MapView
            style={cardStyles.miniMap}
            region={{
              latitude: insp.Latitude,
              longitude: insp.Longitude,
              latitudeDelta: 0.006,
              longitudeDelta: 0.006,
            }}
            scrollEnabled={false}
            zoomEnabled={false}
            pitchEnabled={false}
            rotateEnabled={false}
            pointerEvents="none"
            liteMode
          >
            <Marker
              coordinate={{
                latitude: insp.Latitude,
                longitude: insp.Longitude,
              }}
              pinColor={complete ? "#4CAF50" : "#FF9800"}
            />
          </MapView>
        )}

        <View style={cardStyles.actions}>
          <TouchableOpacity onPress={onMap} style={cardStyles.actionBtn}>
            <MaterialCommunityIcons
              name="map-marker-outline"
              size={16}
              color={theme.colors.primary}
            />
            <Text style={cardStyles.actionText}>Full Map</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onNavigate} style={cardStyles.actionBtn}>
            <MaterialCommunityIcons
              name="navigation-variant-outline"
              size={16}
              color={theme.colors.primary}
            />
            <Text style={cardStyles.actionText}>Navigate</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              router.push({
                pathname: "/addinspection",
                params: { inspectionSk: insp.InspectionSk },
              })
            }
            style={cardStyles.actionBtn}
          >
            <MaterialCommunityIcons
              name="pencil-outline"
              size={16}
              color={theme.colors.primary}
            />
            <Text style={cardStyles.actionText}>Edit</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.cardBackground,
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    backgroundColor: theme.colors.cardBackground,
    borderBottomWidth: theme.layout.borderWidth.thin,
    borderBottomColor: theme.colors.input,
    ...theme.shadows.light,
  },
  navTitle: {
    ...theme.typography.h4,
    fontSize: 16,
  },
  scroll: {
    padding: theme.spacing.m,
    gap: theme.spacing.m,
  },
  footer: {
    flexDirection: "row",
    backgroundColor: theme.colors.cardBackground,
    borderTopWidth: theme.layout.borderWidth.thin,
    borderTopColor: theme.colors.input,
    ...theme.shadows.light,
  },
  footerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.m,
  },
  footerDivider: {
    width: theme.layout.borderWidth.thin,
    backgroundColor: theme.colors.input,
    marginVertical: theme.spacing.s,
  },
  footerBtnText: {
    ...theme.typography.bodyBold,
    fontSize: 14,
    color: theme.colors.primary,
  },
});

const cardStyles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    overflow: "hidden",
    ...theme.shadows.medium,
  },
  sidebar: { width: 5 },
  body: {
    flex: 1,
    padding: theme.spacing.s,
    gap: 4,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.s,
  },
  name: {
    ...theme.typography.bodyBold,
    flex: 1,
  },
  time: {
    fontSize: 12,
    color: theme.colors.textSubtle,
  },
  address: {
    fontSize: 12,
    color: theme.colors.textSubtle,
    lineHeight: 17,
  },
  miniMap: {
    height: 110,
    borderRadius: theme.layout.borderRadius.s,
    marginTop: 4,
    overflow: "hidden",
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing.m,
    marginTop: 4,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  actionText: {
    fontSize: 13,
    color: theme.colors.primary,
    fontWeight: "500",
  },
});
