import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Callout, CalloutSubview, Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useMapStore } from "../stores/useMapStore";

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function formatAddress(insp) {
  return [
    insp.AddressLine1,
    insp.AddressLine2,
    insp.City,
    insp.State,
    insp.ZipCode,
  ]
    .filter(Boolean)
    .join(", ");
}

async function openNavigation(insp) {
  if (!insp.AddressLine1) {
    Alert.alert("No Address", "This inspection has no address to navigate to.");
    return;
  }
  const encoded = encodeURIComponent(formatAddress(insp));
  const url =
    Platform.OS === "ios" ? `maps:?daddr=${encoded}` : `geo:0,0?q=${encoded}`;
  await Linking.openURL(url);
}

// ─── FilterChip ───────────────────────────────────────────────────────────────
function FilterChip({ label, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── InspectionMarker ─────────────────────────────────────────────────────────
function InspectionMarker({ insp, onEdit, onNav }) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  const complete = isComplete(insp);

  return (
    <Marker
      coordinate={{ latitude: insp.Latitude, longitude: insp.Longitude }}
      tracksViewChanges={tracksViewChanges}
    >
      <View
        style={[
          styles.markerDot,
          { backgroundColor: complete ? "#16A34A" : "#D97706" },
        ]}
        onLayout={() => setTracksViewChanges(false)}
      />
      <Callout tooltip>
        <View style={styles.calloutBubble}>
          <CalloutSubview
            style={styles.calloutInfo}
            onPress={() => onEdit(insp)}
          >
            <Text style={styles.calloutName} numberOfLines={1}>
              {insp.FullName || "Unnamed Inspection"}
            </Text>
            <Text style={styles.calloutAddress} numberOfLines={2}>
              {formatAddress(insp) || "No address entered"}
            </Text>
            <Text style={styles.calloutHint}>Tap to edit</Text>
          </CalloutSubview>

          <CalloutSubview
            style={styles.calloutNavBtn}
            onPress={() => onNav(insp)}
          >
            <MaterialCommunityIcons
              name="navigation"
              size={theme.layout.iconSize.l}
              color="#fff"
            />
          </CalloutSubview>
        </View>
        <View style={styles.calloutArrow} />
      </Callout>
    </Marker>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function MapScreen() {
  const router = useRouter();
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [userLocation, setUserLocation] = useState(null);

  const mode = useMapStore((s) => s.mode);
  const targetInspectionSk = useMapStore((s) => s.targetInspectionSk);
  const activeDateFilter = useMapStore((s) => s.activeDateFilter);
  const setDateFilter = useMapStore((s) => s.setDateFilter);

  const inspections = useInspectionStore((s) => s.inspections);
  const sortedIds = useInspectionStore((s) => s.sortedIds);

  // All inspections that have been geocoded
  const allWithCoords = useMemo(
    () =>
      sortedIds
        .map((id) => inspections[id])
        .filter((i) => i?.Latitude && i?.Longitude),
    [inspections, sortedIds],
  );

  // Points to render based on mode and active date filter
  const plotted = useMemo(() => {
    if (mode === "single") {
      const found = allWithCoords.find(
        (i) => i.InspectionSk === targetInspectionSk,
      );
      return found ? [found] : [];
    }
    if (activeDateFilter === "all") return allWithCoords;
    return allWithCoords.filter(
      (i) => dayjs(i.ScheduledAt).format("YYYY-MM-DD") === activeDateFilter,
    );
  }, [mode, targetInspectionSk, allWithCoords, activeDateFilter]);

  // Unique sorted dates that have at least one geocoded inspection
  const filterDates = useMemo(() => {
    if (mode === "single") return [];
    const set = new Set(
      allWithCoords.map((i) => dayjs(i.ScheduledAt).format("YYYY-MM-DD")),
    );
    return [...set].sort();
  }, [allWithCoords, mode]);

  // Request location once on mount
  useEffect(() => {
    async function fetchLocation() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setUserLocation({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
      } catch (e) {
        logError(e, "MapScreen.fetchLocation");
      }
    }
    fetchLocation();
  }, []);

  const fitToPoints = useCallback(() => {
    try {
      const coords = plotted.map((i) => ({
        latitude: i.Latitude,
        longitude: i.Longitude,
      }));
      if (userLocation) coords.push(userLocation);
      if (coords.length === 0) return;

      if (coords.length === 1) {
        mapRef.current?.animateToRegion(
          {
            latitude: coords[0].latitude,
            longitude: coords[0].longitude,
            latitudeDelta: 0.02,
            longitudeDelta: 0.02,
          },
          500,
        );
        return;
      }

      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: { top: 100, right: 50, bottom: 280, left: 50 },
        animated: true,
      });
    } catch (e) {
      logError(e, "MapScreen.fitToPoints");
    }
  }, [plotted, userLocation]);

  // Re-fit whenever the filter or location changes.
  // activeDateFilter and mode are included explicitly because switching back to
  // "all" returns the same allWithCoords reference, so plotted's identity may
  // not change even though the visible set is different — the filter values are
  // the reliable signal that the camera needs to move.
  useEffect(() => {
    if (!mapReady) return;
    const t = setTimeout(fitToPoints, 300);
    return () => clearTimeout(t);
  }, [mapReady, fitToPoints, activeDateFilter, mode]);

  const handleMapReady = useCallback(() => {
    setMapReady(true);
  }, []);

  const handleEditForInspection = useCallback(
    (insp) => {
      try {
        router.push({
          pathname: "/addinspection",
          params: { inspectionSk: insp.InspectionSk },
        });
      } catch (e) {
        logError(
          e,
          `MapScreen.handleEditForInspection sk=${insp.InspectionSk}`,
        );
      }
    },
    [router],
  );

  const handleNavForInspection = useCallback(async (insp) => {
    try {
      await openNavigation(insp);
    } catch (e) {
      logError(e, `MapScreen.handleNavForInspection sk=${insp.InspectionSk}`);
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Nav bar */}
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme.layout.iconSize.l}
            color={theme.colors.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle}>Map</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      {/* Date filter bar — global mode only */}
      {mode === "all" && filterDates.length > 0 && (
        <View style={styles.filterBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterContent}
          >
            <FilterChip
              label="ALL"
              active={activeDateFilter === "all"}
              onPress={() => setDateFilter("all")}
            />
            {filterDates.map((date) => (
              <FilterChip
                key={date}
                label={dayjs(date).format("MMM D")}
                active={activeDateFilter === date}
                onPress={() => setDateFilter(date)}
              />
            ))}
          </ScrollView>
        </View>
      )}

      {/* Map */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          showsUserLocation
          showsMyLocationButton={false}
          onMapReady={handleMapReady}
        >
          {plotted.map((insp) => (
            <InspectionMarker
              key={insp.InspectionSk}
              insp={insp}
              onEdit={handleEditForInspection}
              onNav={handleNavForInspection}
            />
          ))}
        </MapView>

        {/*
          Overlay layer — pointerEvents="box-none" lets map panning pass through
          the container itself while still delivering touches to child views
          (buttons, callout card). Required on Android where the native MapView
          can render above React Native siblings and swallow touch events.
        */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {/* Re-center button */}
          <TouchableOpacity style={styles.recenterBtn} onPress={fitToPoints}>
            <MaterialCommunityIcons
              name="crosshairs-gps"
              size={theme.layout.iconSize.xl}
              color={theme.colors.primary}
            />
          </TouchableOpacity>

          {/* No-location notice (single mode only) */}
          {mode === "single" && plotted.length === 0 && mapReady && (
            <View style={styles.noLocationBanner}>
              <MaterialCommunityIcons
                name="map-marker-off-outline"
                size={theme.layout.iconSize.m}
                color={theme.colors.textSubtle}
              />
              <Text style={styles.noLocationText}>
                No location on this inspection
              </Text>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
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
  },

  filterBar: {
    backgroundColor: theme.colors.cardBackground,
    borderBottomWidth: theme.layout.borderWidth.thin,
    borderBottomColor: theme.colors.input,
  },
  filterContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    gap: theme.spacing.s,
  },
  chip: {
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.l,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    backgroundColor: theme.colors.mainBackground,
  },
  chipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  chipText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },
  chipTextActive: {
    color: "#fff",
    fontWeight: "600",
  },

  mapContainer: {
    flex: 1,
  },

  markerDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.5,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 2,
    elevation: 3,
  },
  markerDotSelected: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
  },

  recenterBtn: {
    position: "absolute",
    bottom: theme.spacing.xl,
    right: theme.spacing.xl,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.s,
    ...theme.shadows.medium,
  },

  noLocationBanner: {
    position: "absolute",
    bottom: theme.spacing.xl,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    ...theme.shadows.light,
  },
  noLocationText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },

  // Callout bubble floats above the marker via react-native-maps Callout
  calloutBubble: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.s,
    gap: theme.spacing.s,
    minWidth: 210,
    maxWidth: 290,
    ...theme.shadows.medium,
  },
  calloutInfo: {
    flex: 1,
    gap: 2,
    paddingVertical: 2,
  },
  calloutName: {
    ...theme.typography.bodyBold,
    color: theme.colors.text,
  },
  calloutAddress: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },
  calloutHint: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    marginTop: 2,
  },
  calloutNavBtn: {
    width: 44,
    height: 44,
    borderRadius: theme.layout.borderRadius.m,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  // CSS-triangle arrow pointing down toward the marker dot
  calloutArrow: {
    width: 0,
    height: 0,
    alignSelf: "center",
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderTopWidth: 9,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: theme.colors.cardBackground,
  },
});
