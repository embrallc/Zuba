// Reusable inspection summary card.
//
// Currently rendered in the horizontal carousel under the month-view
// calendar. All side-effecting callbacks (Full Map, Navigate, Edit) are
// passed in via props so the caller can debounce or otherwise wrap them.
// The card itself stays a pure presentational component.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker } from "react-native-maps";

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
  if (!insp) return false;
  return COMPLETE_FIELDS.every((f) => !!insp[f]);
}

export default function InspectionTooltipCard({
  inspection,
  onMap,
  onNavigate,
  onEdit,
  style,
}) {
  if (!inspection) return null;
  const hasCoords = !!(inspection?.Latitude && inspection?.Longitude);
  const complete = isComplete(inspection);
  const address = [
    inspection?.AddressLine1,
    inspection?.City,
    inspection?.State,
  ]
    .filter(Boolean)
    .join(", ");
  const time = inspection?.ScheduledAt
    ? dayjs(inspection.ScheduledAt).format("h:mm A")
    : null;

  return (
    <View style={[styles.card, style]}>
      <View
        style={[
          styles.sidebar,
          {
            backgroundColor: complete
              ? theme?.colors?.success ?? "#16A34A"
              : theme?.colors?.warning ?? "#D97706",
          },
        ]}
      />
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {inspection?.FullName || "Inspection"}
          </Text>
          {!!time && <Text style={styles.time}>{time}</Text>}
        </View>
        {!!address && (
          <Text style={styles.address} numberOfLines={2}>
            {address}
          </Text>
        )}

        {hasCoords && (
          <MapView
            style={styles.miniMap}
            region={{
              latitude: inspection.Latitude,
              longitude: inspection.Longitude,
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
                latitude: inspection.Latitude,
                longitude: inspection.Longitude,
              }}
              pinColor={complete ? "#4CAF50" : "#FF9800"}
            />
          </MapView>
        )}

        <View style={styles.actions}>
          {onMap ? (
            <TouchableOpacity
              onPress={() => onMap(inspection)}
              style={styles.actionBtn}
              hitSlop={theme?.layout?.hitSlop?.small}
            >
              <MaterialCommunityIcons
                name="map-marker-outline"
                size={16}
                color={theme?.colors?.primary}
              />
              <Text style={styles.actionText}>Full Map</Text>
            </TouchableOpacity>
          ) : null}
          {onNavigate ? (
            <TouchableOpacity
              onPress={() => onNavigate(inspection)}
              style={styles.actionBtn}
              hitSlop={theme?.layout?.hitSlop?.small}
            >
              <MaterialCommunityIcons
                name="navigation-variant-outline"
                size={16}
                color={theme?.colors?.primary}
              />
              <Text style={styles.actionText}>Navigate</Text>
            </TouchableOpacity>
          ) : null}
          {onEdit ? (
            <TouchableOpacity
              onPress={() => onEdit(inspection)}
              style={styles.actionBtn}
              hitSlop={theme?.layout?.hitSlop?.small}
            >
              <MaterialCommunityIcons
                name="pencil-outline"
                size={16}
                color={theme?.colors?.primary}
              />
              <Text style={styles.actionText}>Edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: theme?.colors?.cardBackground ?? "#FFFFFF",
    borderRadius: theme?.layout?.borderRadius?.m ?? 14,
    overflow: "hidden",
    // Stronger shadow than `medium` so the card visibly lifts off the
    // transparent carousel background.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  sidebar: { width: 5 },
  body: {
    flex: 1,
    padding: theme?.spacing?.s ?? 8,
    gap: 4,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme?.spacing?.s ?? 8,
  },
  name: {
    ...(theme?.typography?.bodyBold ?? {}),
    flex: 1,
  },
  time: {
    fontSize: 12,
    color: theme?.colors?.textSubtle,
  },
  address: {
    fontSize: 12,
    color: theme?.colors?.textSubtle,
    lineHeight: 17,
  },
  miniMap: {
    height: 110,
    borderRadius: theme?.layout?.borderRadius?.s ?? 10,
    marginTop: 4,
    overflow: "hidden",
  },
  actions: {
    flexDirection: "row",
    gap: theme?.spacing?.m ?? 14,
    marginTop: 4,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  actionText: {
    fontSize: 13,
    color: theme?.colors?.primary,
    fontWeight: "500",
  },
});
