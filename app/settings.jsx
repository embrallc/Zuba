import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSettingsStore } from "../stores/useSettingsStore";
import { supabase } from "../utils/supabase";
// ── RevenueCat (pending Apple Developer approval) ─────────────────────────────
// import { useSubscriptionStore } from "../stores/useSubscriptionStore";
// import { presentCustomerCenter, presentPaywall } from "../utils/purchases";
// ─────────────────────────────────────────────────────────────────────────────

const APPT_LENGTH_OPTIONS = [15, 30, 45, 60, 75, 90, 105, 120];
const START_HOUR_OPTIONS = [5, 6, 7, 8, 9, 10, 11];

function formatHour(h) {
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function formatApptLength(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}

export default function SettingsScreen() {
  const router = useRouter();
  const showWeekends = useSettingsStore((s) => s.showWeekends);
  const cloudStorageEnabled = useSettingsStore((s) => s.cloudStorageEnabled);
  const apptLengthMinutes = useSettingsStore((s) => s.apptLengthMinutes);
  const calendarStartHour = useSettingsStore((s) => s.calendarStartHour);
  const setShowWeekends = useSettingsStore((s) => s.setShowWeekends);
  const setCloudStorageEnabled = useSettingsStore(
    (s) => s.setCloudStorageEnabled,
  );
  const setApptLengthMinutes = useSettingsStore((s) => s.setApptLengthMinutes);
  const setCalendarStartHour = useSettingsStore((s) => s.setCalendarStartHour);
  // ── RevenueCat (pending Apple Developer approval) ───────────────────────────
  // const isPro = useSubscriptionStore((s) => s.isPro);
  // ───────────────────────────────────────────────────────────────────────────

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <SafeAreaView style={styles.safe}>
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
        <Text style={styles.navTitle}>Settings</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>CALENDAR</Text>

        <SettingRow
          label="Show Saturday & Sunday"
          description="Display weekends in the Week View"
          value={showWeekends}
          onValueChange={setShowWeekends}
        />

        {/* Appointment length picker */}
        <View style={styles.optionCard}>
          <Text style={styles.optionCardLabel}>Default Appointment Length</Text>
          <Text style={styles.optionCardDescription}>
            Controls card height in Week View and overlap detection
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.optionRow}
          >
            {APPT_LENGTH_OPTIONS.map((min) => {
              const selected = apptLengthMinutes === min;
              return (
                <TouchableOpacity
                  key={min}
                  onPress={() => setApptLengthMinutes(min)}
                  style={[
                    styles.optionBtn,
                    selected && styles.optionBtnSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionText,
                      selected && styles.optionTextSelected,
                    ]}
                  >
                    {formatApptLength(min)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* Calendar start hour picker */}
        <View style={styles.optionCard}>
          <Text style={styles.optionCardLabel}>Week View Start Time</Text>
          <Text style={styles.optionCardDescription}>
            The hour the calendar scrolls to when you open the Week View
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.optionRow}
          >
            {START_HOUR_OPTIONS.map((h) => {
              const selected = calendarStartHour === h;
              return (
                <TouchableOpacity
                  key={h}
                  onPress={() => setCalendarStartHour(h)}
                  style={[
                    styles.optionBtn,
                    selected && styles.optionBtnSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionText,
                      selected && styles.optionTextSelected,
                    ]}
                  >
                    {formatHour(h)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        <Text style={styles.sectionLabel}>FORM</Text>

        <NavRow
          label="Personalize Your Form Sections"
          description="Set default section names for new blank inspections"
          onPress={() => router.push("/sectiontemplates")}
        />

        <Text style={styles.sectionLabel}>MESSAGING</Text>

        <NavRow
          label="SMS Templates"
          description="Create up to 5 pre-written messages for client follow-ups"
          onPress={() => router.push("/smstemplates")}
        />


        {/* ── RevenueCat subscription section (pending Apple Developer approval) ──
        <Text style={styles.sectionLabel}>SUBSCRIPTION</Text>
        <View style={rowStyles.container}>
          <View style={rowStyles.text}>
            <Text style={rowStyles.label}>{isPro ? "Embra LLC Pro" : "Free Plan"}</Text>
            <Text style={rowStyles.description}>
              {isPro ? "Cloud sync and premium features active" : "Upgrade to unlock cloud sync and more"}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: isPro ? theme.colors.success : theme.colors.input }]}>
            <Text style={[styles.badgeText, { color: isPro ? "#fff" : theme.colors.textSubtle }]}>
              {isPro ? "PRO" : "FREE"}
            </Text>
          </View>
        </View>
        {isPro ? (
          <NavRow label="Manage Subscription" description="Cancel, restore purchases, or get support" onPress={presentCustomerCenter} />
        ) : (
          <NavRow label="Upgrade to Pro — $5.99/mo" description="Cloud sync, priority support, and future premium features" onPress={presentPaywall} />
        )}
        ── end RevenueCat section ── */}

        <Text style={styles.sectionLabel}>STORAGE</Text>

        <SettingRow
          label="Cloud Storage"
          description="Back up your inspections — $5.99/mo"
          value={cloudStorageEnabled}
          onValueChange={setCloudStorageEnabled}
        />

        <Text style={styles.sectionLabel}>ACCOUNT</Text>

        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={handleSignOut}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="logout"
            size={18}
            color={theme.colors.error}
          />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function NavRow({ label, description, onPress }) {
  return (
    <TouchableOpacity
      style={rowStyles.container}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={rowStyles.text}>
        <Text style={rowStyles.label}>{label}</Text>
        {description ? (
          <Text style={rowStyles.description}>{description}</Text>
        ) : null}
      </View>
      <MaterialCommunityIcons
        name="chevron-right"
        size={22}
        color={theme.colors.textSubtle}
      />
    </TouchableOpacity>
  );
}

function SettingRow({ label, description, value, onValueChange }) {
  return (
    <View style={rowStyles.container}>
      <View style={rowStyles.text}>
        <Text style={rowStyles.label}>{label}</Text>
        {description ? (
          <Text style={rowStyles.description}>{description}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
        thumbColor="#fff"
      />
    </View>
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
    marginTop: theme.spacing.m,
    marginBottom: theme.spacing.s,
  },
  badge: {
    paddingHorizontal: theme.spacing.s,
    paddingVertical: 3,
    borderRadius: theme.layout.borderRadius.full,
  },
  badgeText: {
    ...theme.typography.caption,
    fontWeight: "700",
    fontSize: 11,
  },
  optionCard: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.m,
    paddingBottom: theme.spacing.s,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  optionCardLabel: {
    ...theme.typography.bodyBold,
  },
  optionCardDescription: {
    ...theme.typography.label,
    marginTop: 2,
    marginBottom: theme.spacing.s,
  },
  optionRow: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
  },
  optionBtn: {
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.l,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    backgroundColor: theme.colors.mainBackground,
  },
  optionBtnSelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  optionText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },
  optionTextSelected: {
    color: "#fff",
    fontWeight: "600",
  },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  signOutText: {
    ...theme.typography.bodyBold,
    color: theme.colors.error,
  },
});
