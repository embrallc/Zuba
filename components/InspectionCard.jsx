import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import {
  Alert,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { logError } from "../db/logs";
import { useDebouncedPress } from "../hooks/useDebouncedPress";
import { useMapStore } from "../stores/useMapStore";

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

function isComplete(inspection) {
  return COMPLETE_FIELDS.every((f) => !!inspection[f]);
}

function formatAddress(inspection) {
  const parts = [
    inspection.AddressLine1,
    inspection.AddressLine2,
    inspection.City,
    inspection.State,
    inspection.ZipCode,
  ];
  return parts.filter(Boolean).join(", ");
}

async function openSms(phone) {
  if (!phone) {
    Alert.alert("No phone number on this inspection.");
    return;
  }
  await Linking.openURL(`sms:${phone}`);
}

async function openCall(phone) {
  if (!phone) {
    Alert.alert("No phone number on this inspection.");
    return;
  }
  await Linking.openURL(`tel:${phone}`);
}

async function openEmail(email) {
  if (!email) {
    Alert.alert("No email address on this inspection.");
    return;
  }
  await Linking.openURL(`mailto:${email}`);
}

async function openNavigation(inspection) {
  if (!inspection.AddressLine1) {
    Alert.alert("No address on this inspection.");
    return;
  }
  const addr = formatAddress(inspection);
  const encoded = encodeURIComponent(addr);
  const url =
    Platform.OS === "ios" ? `maps:?daddr=${encoded}` : `geo:0,0?q=${encoded}`;
  await Linking.openURL(url);
}

export default function InspectionCard({ inspection, onPress }) {
  const openForInspection = useMapStore((s) => s.openForInspection);
  const router = useRouter();

  const scale = useSharedValue(1);
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const complete = isComplete(inspection);
  const address = formatAddress(inspection);
  const scheduledDate = inspection.ScheduledAt
    ? dayjs(inspection.ScheduledAt).format("MMM D, YYYY")
    : "—";
  const scheduledTime = inspection.ScheduledAt
    ? dayjs(inspection.ScheduledAt).format("h:mm A")
    : "";

  const handleSms = useDebouncedPress(async () => {
    try {
      await openSms(inspection.Phone);
    } catch (e) {
      logError(e, `InspectionCard.handleSms sk=${inspection.InspectionSk}`);
    }
  });

  const handleCall = useDebouncedPress(async () => {
    try {
      await openCall(inspection.Phone);
    } catch (e) {
      logError(e, `InspectionCard.handleCall sk=${inspection.InspectionSk}`);
    }
  });

  const handleEmail = useDebouncedPress(async () => {
    try {
      await openEmail(inspection.Email);
    } catch (e) {
      logError(e, `InspectionCard.handleEmail sk=${inspection.InspectionSk}`);
    }
  });

  const handleNavigation = useDebouncedPress(async () => {
    try {
      await openNavigation(inspection);
    } catch (e) {
      logError(
        e,
        `InspectionCard.handleNavigation sk=${inspection.InspectionSk}`,
      );
    }
  });

  const handleMapPin = useDebouncedPress(() => {
    try {
      openForInspection(inspection.InspectionSk);
      router.push("/map");
    } catch (e) {
      logError(e, `InspectionCard.handleMapPin sk=${inspection.InspectionSk}`);
    }
  });

  const handleOpenForm = useDebouncedPress(() => {
    try {
      router.push({
        pathname: "/inspectionform",
        params: { inspectionSk: inspection.InspectionSk },
      });
    } catch (e) {
      logError(e, `InspectionCard.handleOpenForm sk=${inspection.InspectionSk}`);
    }
  });

  return (
    <Animated.View style={cardStyle}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={() => {
          scale.value = withSpring(0.97, { damping: 14, stiffness: 220 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 14, stiffness: 220 });
        }}
        activeOpacity={1}
        style={styles.container}
      >
        <View
          style={[
            styles.sidebar,
            {
              backgroundColor: complete
                ? theme.colors.success
                : theme.colors.warning,
            },
          ]}
        />

        <View style={styles.body}>
          <View style={styles.headerRow}>
            <Text style={styles.name} numberOfLines={1}>
              {inspection.FullName || "Unnamed Inspection"}
            </Text>
            <Text style={styles.datetime}>
              {scheduledDate}
              {scheduledTime ? `  ${scheduledTime}` : ""}
            </Text>
          </View>

          {address ? (
            <Text style={styles.address} numberOfLines={1}>
              {address}
            </Text>
          ) : (
            <Text style={styles.addressEmpty}>No address entered</Text>
          )}

          <View style={styles.actions}>
            {!!inspection.Phone && (
              <TouchableOpacity
                onPress={handleSms}
                hitSlop={theme.layout.hitSlop.medium}
                style={styles.actionBtn}
              >
                <MaterialCommunityIcons
                  name="message-text-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            )}

            {!!inspection.Phone && (
              <TouchableOpacity
                onPress={handleCall}
                hitSlop={theme.layout.hitSlop.medium}
                style={styles.actionBtn}
              >
                <MaterialCommunityIcons
                  name="phone-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            )}

            {!!inspection.Email && (
              <TouchableOpacity
                onPress={handleEmail}
                hitSlop={theme.layout.hitSlop.medium}
                style={styles.actionBtn}
              >
                <MaterialCommunityIcons
                  name="email-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            )}

            {!!inspection.AddressLine1 && (
              <TouchableOpacity
                onPress={handleNavigation}
                hitSlop={theme.layout.hitSlop.medium}
                style={styles.actionBtn}
              >
                <MaterialCommunityIcons
                  name="navigation-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            )}

            {!!(inspection.Latitude && inspection.Longitude) && (
              <TouchableOpacity
                onPress={handleMapPin}
                hitSlop={theme.layout.hitSlop.medium}
                style={styles.actionBtn}
              >
                <MaterialCommunityIcons
                  name="map-marker-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            )}

            <TouchableOpacity
              onPress={handleOpenForm}
              hitSlop={theme.layout.hitSlop.medium}
              style={[styles.actionBtn, styles.formBtn]}
            >
              <MaterialCommunityIcons
                name="clipboard-text-outline"
                size={theme.layout.iconSize.m}
                color={theme.colors.primary}
              />
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    marginHorizontal: theme.spacing.s,
    marginBottom: theme.spacing.s,
    overflow: "hidden",
    ...theme.shadows.light,
  },
  sidebar: {
    width: 5,
  },
  body: {
    flex: 1,
    padding: theme.spacing.m,
    gap: theme.spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing.s,
  },
  name: {
    ...theme.typography.h4,
    flex: 1,
  },
  datetime: {
    ...theme.typography.h4,
    flexShrink: 0,
  },
  address: {
    ...theme.typography.label,
  },
  addressEmpty: {
    ...theme.typography.caption,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing.m,
    marginTop: theme.spacing.xs,
  },
  actionBtn: {
    padding: theme.spacing.xs,
  },
  formBtn: {
    marginLeft: "auto",
  },
});
