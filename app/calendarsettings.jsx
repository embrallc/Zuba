import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { logError } from "../db/logs";
import { useCalendarStore } from "../stores/useCalendarStore";
import {
  getCalendarPermissionStatus,
  isChosenCalendarPresent,
  listWritableCalendars,
  requestCalendarAccess,
  resyncNow,
} from "../utils/calendarSync";

export default function CalendarSettingsScreen() {
  const router = useRouter();
  const enabled = useCalendarStore((s) => s.enabled);
  const push = useCalendarStore((s) => s.push);
  const pull = useCalendarStore((s) => s.pull);
  const calendarId = useCalendarStore((s) => s.calendarId);
  const calendarTitle = useCalendarStore((s) => s.calendarTitle);
  const sourceName = useCalendarStore((s) => s.sourceName);
  const update = useCalendarStore((s) => s.update);

  const [permission, setPermission] = useState("undetermined");
  const [calendars, setCalendars] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [loadingCals, setLoadingCals] = useState(false);
  const [chosenPresent, setChosenPresent] = useState(true);
  const [resyncing, setResyncing] = useState(false);

  const refreshPermission = useCallback(async () => {
    setPermission(await getCalendarPermissionStatus());
  }, []);

  useEffect(() => {
    refreshPermission();
  }, [refreshPermission]);

  // When enabled with a chosen calendar, verify it still exists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (enabled && calendarId) {
        const present = await isChosenCalendarPresent();
        if (!cancelled) setChosenPresent(present);
      } else if (!cancelled) {
        setChosenPresent(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, calendarId]);

  async function loadCalendars() {
    setLoadingCals(true);
    try {
      const { granted, calendars: cals } = await listWritableCalendars();
      setPermission(granted ? "granted" : "denied");
      setCalendars(cals);
    } catch (e) {
      logError(e, "CalendarSettings.loadCalendars");
    } finally {
      setLoadingCals(false);
    }
  }

  async function handleToggleMaster(val) {
    if (!val) {
      // Keep the chosen calendar so resuming is one tap.
      await update({ enabled: false });
      return;
    }
    const granted = await requestCalendarAccess();
    setPermission(granted ? "granted" : "denied");
    if (!granted) {
      Alert.alert(
        "Calendar Access Needed",
        "Turn on calendar access for this app in your device Settings to sync inspections.",
        [
          { text: "Not Now", style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    await update({ enabled: true });
    if (!calendarId) {
      setShowPicker(true);
      loadCalendars();
    } else {
      kickResync();
    }
  }

  async function handlePickCalendar(cal) {
    await update({
      calendarId: cal.id,
      calendarTitle: cal.title,
      sourceName: cal.sourceName,
    });
    setShowPicker(false);
    setChosenPresent(true);
    kickResync();
  }

  function openPicker() {
    setShowPicker(true);
    loadCalendars();
  }

  async function kickResync() {
    setResyncing(true);
    try {
      await resyncNow();
    } catch (e) {
      logError(e, "CalendarSettings.kickResync");
    } finally {
      setResyncing(false);
    }
  }

  async function handleShareInstruction() {
    const where = calendarTitle ? `your “${calendarTitle}” calendar` : "the synced calendar";
    const msg =
      `To add an inspection to Zanbi: create the event in ${where} and put ` +
      `#zanbi anywhere in the title or notes. Add the client's phone number ` +
      `and/or email in the notes too — Zanbi pulls them into the inspection so ` +
      `the inspector can follow up. Events without #zanbi stay private and ` +
      `won't appear in Zanbi.`;
    try {
      await Share.share({ message: msg });
    } catch (e) {
      logError(e, "CalendarSettings.shareInstruction");
    }
  }

  const subTogglesDisabled = !enabled || !calendarId;

  return (
    <SafeAreaView style={styles.safe}>
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
        <Text style={styles.navTitle}>Calendar</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Permission banner */}
        {permission === "denied" && (
          <TouchableOpacity
            style={styles.banner}
            onPress={() => Linking.openSettings()}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons
              name="calendar-alert"
              size={20}
              color={theme.colors.error}
            />
            <Text style={styles.bannerText}>
              Calendar access is off. Tap to open Settings and turn it on.
            </Text>
          </TouchableOpacity>
        )}

        {/* Missing chosen calendar */}
        {enabled && calendarId && !chosenPresent && (
          <TouchableOpacity
            style={styles.banner}
            onPress={openPicker}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons
              name="calendar-remove"
              size={20}
              color={theme.colors.error}
            />
            <Text style={styles.bannerText}>
              Your chosen calendar is no longer on this device. Tap to pick
              another.
            </Text>
          </TouchableOpacity>
        )}

        <Text style={styles.sectionLabel}>CALENDAR SYNC</Text>

        <View style={rowStyles.container}>
          <View style={rowStyles.text}>
            <Text style={rowStyles.label}>Calendar Sync</Text>
            <Text style={rowStyles.description}>
              Two-way sync between Zanbi and your Apple or Google calendar. Pick
              one calendar to share with your team.
            </Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={handleToggleMaster}
            trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
            thumbColor="#fff"
          />
        </View>

        {enabled && (
          <>
            {/* Chosen calendar */}
            <TouchableOpacity
              style={rowStyles.container}
              onPress={openPicker}
              activeOpacity={0.7}
            >
              <View style={rowStyles.text}>
                <Text style={rowStyles.label}>
                  {calendarTitle ? "Synced calendar" : "Choose a calendar"}
                </Text>
                <Text style={rowStyles.description}>
                  {calendarTitle
                    ? `${calendarTitle}${sourceName ? ` · ${sourceName}` : ""}`
                    : "Tap to pick which calendar to sync"}
                </Text>
              </View>
              <MaterialCommunityIcons
                name="chevron-right"
                size={22}
                color={theme.colors.textSubtle}
              />
            </TouchableOpacity>

            {/* Picker */}
            {showPicker && (
              <View style={styles.pickerCard}>
                {loadingCals ? (
                  <View style={styles.pickerLoading}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  </View>
                ) : calendars.length === 0 ? (
                  <Text style={styles.pickerEmpty}>
                    No writable calendars found. On iPhone, add your Google or
                    iCloud account in Settings → Calendar → Accounts, then come
                    back.
                  </Text>
                ) : (
                  calendars.map((cal) => {
                    const selected = cal.id === calendarId;
                    return (
                      <TouchableOpacity
                        key={cal.id}
                        style={styles.calRow}
                        onPress={() => handlePickCalendar(cal)}
                        activeOpacity={0.7}
                      >
                        <View
                          style={[
                            styles.calDot,
                            { backgroundColor: cal.color || theme.colors.primary },
                          ]}
                        />
                        <View style={styles.calText}>
                          <Text style={styles.calTitle}>{cal.title}</Text>
                          {cal.sourceName ? (
                            <Text style={styles.calSource}>{cal.sourceName}</Text>
                          ) : null}
                        </View>
                        {selected && (
                          <MaterialCommunityIcons
                            name="check-circle"
                            size={20}
                            color={theme.colors.success}
                          />
                        )}
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            )}

            {/* Sub-toggles */}
            <Text style={styles.sectionLabel}>WHAT TO SYNC</Text>
            <View style={rowStyles.container}>
              <View style={rowStyles.text}>
                <Text style={rowStyles.label}>Push inspections</Text>
                <Text style={rowStyles.description}>
                  Add and update your scheduled inspections on the calendar
                </Text>
              </View>
              <Switch
                value={push}
                onValueChange={(val) => update({ push: val })}
                disabled={subTogglesDisabled}
                trackColor={{
                  false: theme.colors.input,
                  true: theme.colors.primary,
                }}
                thumbColor="#fff"
              />
            </View>
            <View style={rowStyles.container}>
              <View style={rowStyles.text}>
                <Text style={rowStyles.label}>Pull #zanbi events</Text>
                <Text style={rowStyles.description}>
                  Turn calendar events tagged #zanbi into inspections (e.g. ones
                  your assistant adds)
                </Text>
              </View>
              <Switch
                value={pull}
                onValueChange={(val) => update({ pull: val })}
                disabled={subTogglesDisabled}
                trackColor={{
                  false: theme.colors.input,
                  true: theme.colors.primary,
                }}
                thumbColor="#fff"
              />
            </View>

            {/* Tagging help */}
            <Text style={styles.sectionLabel}>THE #zanbi TAG</Text>
            <View style={styles.helpCard}>
              <Text style={styles.helpText} selectable>
                Only events with <Text style={styles.tag}>#zanbi</Text> in the
                title or notes become inspections — anything else in the
                calendar stays private. Zanbi adds the tag automatically to events
                it creates. Put a phone number and/or email in the notes and
                Zanbi fills in the inspection's contact info. Share this with an
                assistant so events they add show up for you:
              </Text>
              <TouchableOpacity
                style={styles.shareBtn}
                onPress={handleShareInstruction}
                activeOpacity={0.8}
              >
                <MaterialCommunityIcons
                  name="share-variant"
                  size={15}
                  color={theme.colors.primary}
                />
                <Text style={styles.shareBtnText}>Share tagging instructions</Text>
              </TouchableOpacity>
            </View>

            {/* Re-sync */}
            <TouchableOpacity
              style={styles.resyncBtn}
              onPress={kickResync}
              activeOpacity={0.8}
              disabled={resyncing || subTogglesDisabled}
            >
              {resyncing ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <MaterialCommunityIcons
                  name="sync"
                  size={16}
                  color={theme.colors.primary}
                />
              )}
              <Text style={styles.resyncText}>
                {resyncing ? "Syncing…" : "Re-sync now"}
              </Text>
            </TouchableOpacity>

            <Text style={styles.footNote}>
              Using more than one device? Turn on Pull #zanbi events on just one
              of them to avoid duplicates.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme?.colors?.cardBackground,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    borderRadius: theme?.layout?.borderRadius?.m,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  text: {
    flex: 1,
    marginRight: theme?.spacing?.m,
  },
  label: {
    ...theme?.typography?.bodyBold,
  },
  description: {
    ...theme?.typography?.label,
    marginTop: 2,
  },
});

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    borderBottomWidth: theme?.layout?.borderWidth?.thin,
    borderBottomColor: theme?.colors?.input,
    ...theme?.shadows?.light,
  },
  navTitle: {
    ...theme?.typography?.h4,
  },
  content: {
    padding: theme?.spacing?.m,
    paddingBottom: theme?.spacing?.xxl,
  },
  sectionLabel: {
    ...theme?.typography?.overline,
    marginTop: theme?.spacing?.m,
    marginBottom: theme?.spacing?.s,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.s,
    backgroundColor: theme?.colors?.cardBackground,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.error,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.s,
    marginBottom: theme?.spacing?.s,
  },
  bannerText: {
    ...theme?.typography?.label,
    color: theme?.colors?.error,
    flex: 1,
  },
  pickerCard: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.xs,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  pickerLoading: {
    paddingVertical: theme?.spacing?.m,
    alignItems: "center",
  },
  pickerEmpty: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    paddingVertical: theme?.spacing?.s,
  },
  calRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme?.spacing?.s,
  },
  calDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: theme?.spacing?.s,
  },
  calText: {
    flex: 1,
  },
  calTitle: {
    ...theme?.typography?.body,
  },
  calSource: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginTop: 1,
  },
  helpCard: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  helpText: {
    ...theme?.typography?.label,
    lineHeight: 20,
  },
  tag: {
    ...theme?.typography?.label,
    color: theme?.colors?.primary,
    fontWeight: "700",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.primary,
    borderRadius: theme?.layout?.borderRadius?.full,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: 6,
    marginTop: theme?.spacing?.s,
  },
  shareBtnText: {
    ...theme?.typography?.label,
    color: theme?.colors?.primary,
    fontWeight: "600",
  },
  resyncBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.s,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: theme?.spacing?.m,
    marginTop: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  resyncText: {
    ...theme?.typography?.bodyBold,
    color: theme?.colors?.primary,
  },
  footNote: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginTop: theme?.spacing?.m,
    textAlign: "center",
  },
});
