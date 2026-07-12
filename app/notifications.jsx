import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import {
  NOTIFICATION_NAMES,
  upsertNotificationSetting,
} from "../db/notificationSettings";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  cancelAllUpcomingApptNotifs,
  rescheduleAllUpcomingApptNotifs,
} from "../utils/notifications";

// Display config for each toggle. Adding a new notification = new entry here
// + new key in NOTIFICATION_NAMES + a scheduler in utils/notifications.js.
const TOGGLES = [
  {
    name: NOTIFICATION_NAMES.UPCOMING_APPT,
    label: "Upcoming Appointments",
    description: "Get a reminder before each scheduled inspection",
  },
];

export default function NotificationsScreen() {
  const router = useRouter();
  const userSk = useSettingsStore((s) => s.userSk);
  const persisted = useSettingsStore((s) => s.notifications);
  const setNotifications = useSettingsStore((s) => s.setNotifications);

  // Draft mirrors the store on entry; user edits the draft and Save flushes
  // it to AsyncStorage / SQLite / cloud all at once.
  const [draft, setDraft] = useState(!persisted ? {} : persisted);
  const [status, setStatus] = useState("idle"); // 'idle' | 'saving' | 'saved' | 'error'

  // Reset the draft if the store changes underneath us (e.g. a sync pull
  // landed while the screen was open).
  useEffect(() => {
    setDraft(!persisted ? {} : persisted);
  }, [persisted]);

  const dirty = TOGGLES.some((t) => !!draft[t?.name] !== !!persisted[t?.name]);

  function toggle(name) {
    if (!name) {
      return;
    }
    setDraft((d) => ({ ...d, [name]: !d[name] }));
    if (status === "saved" || status === "error") setStatus("idle");
  }

  async function handleSave() {
    if (status === "saving" || !dirty || !userSk || !draft || !persisted)
      return;
    setStatus("saving");
    // Snapshot the Upcoming Appointment toggle before/after so we can fire
    // the matching sweep (schedule everything / cancel everything) once the
    // persist completes.
    const prevUpcoming = !!persisted?.[NOTIFICATION_NAMES.UPCOMING_APPT];
    const nextUpcoming = !!draft?.[NOTIFICATION_NAMES.UPCOMING_APPT];
    try {
      // Notifications are device-local — SQLite + the store (which writes
      // AsyncStorage) are the source of truth. No cloud push.
      for (const t of TOGGLES) {
        if (!!draft[t?.name] !== !!persisted[t?.name]) {
          await upsertNotificationSetting(userSk, t?.name, !!draft[t?.name]);
        }
      }
      await setNotifications(draft);

      // OS-side sweep — fire-and-forget so the "saved" check shows up fast.
      // Reschedule must come AFTER setNotifications, since the scheduler
      // gates on the in-memory master toggle (which we just updated).
      if (prevUpcoming !== nextUpcoming) {
        if (nextUpcoming) {
          rescheduleAllUpcomingApptNotifs().catch((e) =>
            logError(e, "NotificationsScreen.handleSave.reschedule"),
          );
        } else {
          cancelAllUpcomingApptNotifs().catch((e) =>
            logError(e, "NotificationsScreen.handleSave.cancelAll"),
          );
        }
      }

      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch (e) {
      logError(e, "NotificationsScreen.handleSave");
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  }

  return (
    <SafeAreaView style={styles?.safe} edges={["top", "left", "right"]}>
      <View style={styles?.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme?.layout?.iconSize?.l}
            color={theme?.colors?.icon}
          />
        </TouchableOpacity>
        <Text style={styles?.navTitle}>Notifications</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!dirty || status === "saving"}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          {status === "saving" ? (
            <ActivityIndicator size="small" color={theme?.colors?.primary} />
          ) : status === "saved" ? (
            <MaterialCommunityIcons
              name="check-circle"
              size={theme?.layout?.iconSize.l}
              color={theme?.colors?.success}
            />
          ) : status === "error" ? (
            <MaterialCommunityIcons
              name="alert-circle-outline"
              size={theme?.layout?.iconSize.l}
              color={theme?.colors?.error}
            />
          ) : (
            <MaterialCommunityIcons
              name="check"
              size={theme?.layout?.iconSize.l}
              color={dirty ? theme?.colors?.primary : theme?.colors?.textFine}
            />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles?.content}>
        <Text style={styles?.sectionLabel}>NOTIFICATIONS</Text>
        {TOGGLES.map((t) => (
          <View key={t?.name} style={rowStyles?.container}>
            <View style={rowStyles?.text}>
              <Text style={rowStyles?.label}>{t?.label}</Text>
              {t.description ? (
                <Text style={rowStyles?.description}>{t?.description}</Text>
              ) : null}
            </View>
            <Switch
              value={!!draft[t?.name]}
              onValueChange={() => toggle(t?.name)}
              trackColor={{
                false: theme?.colors?.input,
                true: theme?.colors?.primary,
              }}
              thumbColor="#fff"
            />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  text: {
    flex: 1,
    marginRight: theme.spacing.m,
  },
  label: {
    ...theme.typography.bodyBold,
  },
  description: {
    ...theme.typography.label,
    marginTop: 2,
  },
});

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
  content: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
  },
  sectionLabel: {
    ...theme.typography.overline,
    marginBottom: theme.spacing.s,
  },
});
