import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { getAllInspections } from "../db/inspections";
import { logError } from "../db/logs";
import { updateUserName } from "../db/users";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { signOutAndClear, supabase } from "../utils/supabase";
import { syncAll } from "../utils/sync";
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
  const userProfile = useSettingsStore((s) => s.userProfile);
  const userSk = useSettingsStore((s) => s.userSk);
  const fname = useSettingsStore((s) => s.fname);
  const lname = useSettingsStore((s) => s.lname);
  const setFname = useSettingsStore((s) => s.setFname);
  const setLname = useSettingsStore((s) => s.setLname);
  const loadInspections = useInspectionStore((s) => s.load);

  // 'idle' | 'syncing' | 'done' | 'error'
  const [syncStatus, setSyncStatus] = useState("idle");

  // 'idle' | 'saving' | 'saved' | 'error' — single indicator covers both
  // first + last fields since both fire updateUserName.
  const [nameStatus, setNameStatus] = useState("idle");
  const nameSaveTimer = useRef(null);
  const nameStatusResetTimer = useRef(null);

  // Cancel pending name-save / status-reset timers on unmount so they don't
  // fire on an unmounted component.
  useEffect(() => {
    return () => {
      if (nameSaveTimer.current) clearTimeout(nameSaveTimer.current);
      if (nameStatusResetTimer.current) clearTimeout(nameStatusResetTimer.current);
    };
  }, []);

  function scheduleNameSave(nextFname, nextLname) {
    if (nameSaveTimer.current) clearTimeout(nameSaveTimer.current);
    nameSaveTimer.current = setTimeout(async () => {
      setNameStatus("saving");
      const ok = await updateUserName(userSk, {
        fname: nextFname,
        lname: nextLname,
      });
      setNameStatus(ok ? "saved" : "error");
      if (nameStatusResetTimer.current) clearTimeout(nameStatusResetTimer.current);
      nameStatusResetTimer.current = setTimeout(
        () => setNameStatus("idle"),
        ok ? 1500 : 2500,
      );
    }, 700);
  }

  function handleFnameChange(value) {
    setFname(value);
    scheduleNameSave(value, lname);
  }

  function handleLnameChange(value) {
    setLname(value);
    scheduleNameSave(fname, value);
  }

  async function handleSyncNow() {
    if (syncStatus === "syncing") return;
    setSyncStatus("syncing");
    try {
      await syncAll();
      const inspections = await getAllInspections();
      loadInspections(inspections ?? []);
      setSyncStatus("done");
      setTimeout(() => setSyncStatus("idle"), 1800);
    } catch (e) {
      logError(e, "SettingsScreen.handleSyncNow");
      setSyncStatus("error");
      setTimeout(() => setSyncStatus("idle"), 2500);
    }
  }
  // ── RevenueCat (pending Apple Developer approval) ───────────────────────────
  // const isPro = useSubscriptionStore((s) => s.isPro);
  // ───────────────────────────────────────────────────────────────────────────

  async function handleSignOut() {
    try {
      await signOutAndClear();
    } catch (e) {
      logError(e, "SettingsScreen.handleSignOut");
    } finally {
      // Always navigate away — leaving the user on Settings with a half-cleared
      // session is worse than retrying sign-in at the login screen.
      router.replace("/login");
    }
  }

  const [deleting, setDeleting] = useState(false);

  function handleDeleteAccount() {
    Alert.alert(
      "Delete Account",
      "This permanently removes your account. If you're the only member of your organization, all your inspections and photos will also be deleted. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: confirmDeleteAccount,
        },
      ],
    );
  }

  async function confirmDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("delete-account");
      if (error) {
        // supabase-js wraps non-2xx responses in a FunctionsHttpError with the
        // underlying Response on `error.context`. Read the body so the user
        // sees the real server-side reason rather than the generic
        // "non 2xx status" wrapper message.
        let detail = error.message ?? "Could not delete account.";
        try {
          const body = await error.context?.json?.();
          if (body?.error) detail = body.error;
        } catch (_) {}
        logError(error, `SettingsScreen.deleteAccount.invoke detail="${detail}"`);
        Alert.alert("Delete Failed", detail);
        return;
      }
      if (data?.status === "blocked_sole_owner") {
        Alert.alert(
          "Promote Another Owner First",
          data.message ??
            "You're the only owner of this organization. Promote another user to owner in Manage Users before deleting your account.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Manage Users",
              onPress: () => router.push("/manageusers"),
            },
          ],
        );
        return;
      }
      // Either full_org_deleted or user_only_deleted — sign out and exit.
      await signOutAndClear();
      router.replace("/login");
    } catch (e) {
      logError(e, "SettingsScreen.deleteAccount");
      Alert.alert("Delete Failed", "Could not delete account.");
    } finally {
      setDeleting(false);
    }
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
        <TouchableOpacity
          style={styles.syncRow}
          onPress={handleSyncNow}
          activeOpacity={0.7}
          disabled={syncStatus === "syncing"}
        >
          <View style={styles.syncIconWrap}>
            {syncStatus === "syncing" ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : syncStatus === "done" ? (
              <MaterialCommunityIcons
                name="check-circle"
                size={22}
                color={theme.colors.success}
              />
            ) : syncStatus === "error" ? (
              <MaterialCommunityIcons
                name="alert-circle-outline"
                size={22}
                color={theme.colors.error}
              />
            ) : (
              <MaterialCommunityIcons
                name="cloud-sync-outline"
                size={22}
                color={theme.colors.primary}
              />
            )}
          </View>
          <View style={styles.syncText}>
            <Text style={styles.syncLabel}>
              {syncStatus === "syncing"
                ? "Syncing…"
                : syncStatus === "done"
                  ? "Up to date"
                  : syncStatus === "error"
                    ? "Sync failed"
                    : "Sync now"}
            </Text>
            <Text style={styles.syncDescription}>
              {syncStatus === "error"
                ? "Tap to try again"
                : "Push local changes and refresh from the cloud"}
            </Text>
          </View>
        </TouchableOpacity>

        <View style={styles.profileHeader}>
          <Text style={styles.sectionLabel}>PROFILE</Text>
          <View style={styles.nameStatusWrap}>
            {nameStatus === "saving" && (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            )}
            {nameStatus === "saved" && (
              <MaterialCommunityIcons
                name="check-circle"
                size={16}
                color={theme.colors.success}
              />
            )}
            {nameStatus === "error" && (
              <MaterialCommunityIcons
                name="alert-circle-outline"
                size={16}
                color={theme.colors.error}
              />
            )}
          </View>
        </View>

        <View style={styles.profileCard}>
          <Text style={styles.fieldLabel}>First name</Text>
          <TextInput
            style={styles.fieldInput}
            value={fname ?? ""}
            onChangeText={handleFnameChange}
            placeholder="Enter your first name"
            placeholderTextColor={theme.colors.textFine}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="next"
          />
          <View style={styles.fieldDivider} />
          <Text style={styles.fieldLabel}>Last name</Text>
          <TextInput
            style={styles.fieldInput}
            value={lname ?? ""}
            onChangeText={handleLnameChange}
            placeholder="Enter your last name"
            placeholderTextColor={theme.colors.textFine}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
          />
        </View>

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

        {(userProfile === "owner" || userProfile === "admin") && (
          <>
            <Text style={styles.sectionLabel}>TEAM</Text>
            {userProfile === "owner" && (
              <NavRow
                label="Manage Users"
                description="Set owner, admin, or member access for your organization"
                onPress={() => router.push("/manageusers")}
              />
            )}
            <NavRow
              label="Unassigned Records"
              description="Reassign inspections that were left behind by a deleted account"
              onPress={() => router.push("/unassigned")}
            />
            <NavRow
              label="All Inspections"
              description="View every inspection in your org and reassign when a teammate is out"
              onPress={() => router.push("/allinspections")}
            />
          </>
        )}


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

        <TouchableOpacity
          style={[styles.deleteBtn, deleting && styles.deleteBtnDisabled]}
          onPress={handleDeleteAccount}
          activeOpacity={0.7}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator size="small" color={theme.colors.error} />
          ) : (
            <MaterialCommunityIcons
              name="trash-can-outline"
              size={18}
              color={theme.colors.error}
            />
          )}
          <Text style={styles.deleteText}>
            {deleting ? "Deleting…" : "Delete Account"}
          </Text>
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
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  nameStatusWrap: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.s,
  },
  profileCard: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  fieldLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.xs,
  },
  fieldInput: {
    ...theme.typography.body,
    color: theme.colors.text,
    paddingVertical: theme.spacing.xs,
  },
  fieldDivider: {
    height: theme.layout.borderWidth.thin,
    backgroundColor: theme.colors.input,
    marginVertical: theme.spacing.xs,
  },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    ...theme.shadows.light,
  },
  syncIconWrap: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing.s,
  },
  syncText: {
    flex: 1,
  },
  syncLabel: {
    ...theme.typography.bodyBold,
  },
  syncDescription: {
    ...theme.typography.label,
    marginTop: 2,
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
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.error,
    marginBottom: theme.spacing.s,
  },
  deleteBtnDisabled: {
    opacity: theme.layout.opacity.disabled,
  },
  deleteText: {
    ...theme.typography.bodyBold,
    color: theme.colors.error,
  },
});
