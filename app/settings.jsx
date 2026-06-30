import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Guard } from "../components/Guard";
import NotificationBadge from "../components/NotificationBadge";
import { getAllInspections } from "../db/inspections";
import { logError } from "../db/logs";
import { getOrgTimezone, setOrgTimezone } from "../db/organizations";
import { updateUserName } from "../db/users";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { ensureMediaWritePermission } from "../utils/inspectionPhotos";
import { signOutAndClear, supabase } from "../utils/supabase";
import { syncAll } from "../utils/sync";
import { useSubscriptionStore } from "../stores/useSubscriptionStore";
import { openManageSubscriptions, requestAccountDeletion } from "../utils/account";
import {
  logOutPurchases,
  PAYWALL_RESULT,
  presentCustomerCenter,
  presentPaywall,
  presentPaywallForUpgrade,
} from "../utils/purchases";

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
  const apptLengthMinutes = useSettingsStore((s) => s.apptLengthMinutes);
  const calendarStartHour = useSettingsStore((s) => s.calendarStartHour);
  const setShowWeekends = useSettingsStore((s) => s.setShowWeekends);
  const setApptLengthMinutes = useSettingsStore((s) => s.setApptLengthMinutes);
  const setCalendarStartHour = useSettingsStore((s) => s.setCalendarStartHour);
  const userProfile = useSettingsStore((s) => s.userProfile);
  const userSk = useSettingsStore((s) => s.userSk);
  const orgSk = useSettingsStore((s) => s.orgSk);
  const fname = useSettingsStore((s) => s.fname);
  const lname = useSettingsStore((s) => s.lname);
  const setFname = useSettingsStore((s) => s.setFname);
  const setLname = useSettingsStore((s) => s.setLname);
  const aiRewriteEnabled = useSettingsStore((s) => s.aiRewriteEnabled);
  const setAiRewriteEnabled = useSettingsStore((s) => s.setAiRewriteEnabled);
  const apptReminderSmsEnabled = useSettingsStore(
    (s) => s.apptReminderSmsEnabled,
  );
  const setApptReminderSmsEnabled = useSettingsStore(
    (s) => s.setApptReminderSmsEnabled,
  );
  const persistPhotosToDevice = useSettingsStore((s) => s.persistPhotosToDevice);
  const setPersistPhotosToDevice = useSettingsStore(
    (s) => s.setPersistPhotosToDevice,
  );
  const photoAlbumEnabled = useSettingsStore((s) => s.photoAlbumEnabled);
  const setPhotoAlbumEnabled = useSettingsStore((s) => s.setPhotoAlbumEnabled);
  const loadInspections = useInspectionStore((s) => s.load);
  // Unread-cancellation badge (on the Cancelled archive row + the bounce).
  const cancelCount = useSettingsStore((s) => s.unviewedCancelledCount);
  const cancelPulse = useSettingsStore((s) => s.cancelBadgePulseKey);
  const refreshCancelledCount = useSettingsStore((s) => s.refreshCancelledCount);
  const bumpCancelBadgePulse = useSettingsStore((s) => s.bumpCancelBadgePulse);

  // Recompute the count + replay the bounce each time Settings is entered.
  useFocusEffect(
    useCallback(() => {
      refreshCancelledCount?.();
      bumpCancelBadgePulse?.();
    }, [refreshCancelledCount, bumpCancelBadgePulse]),
  );

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
      if (nameStatusResetTimer.current)
        clearTimeout(nameStatusResetTimer.current);
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
      if (nameStatusResetTimer.current)
        clearTimeout(nameStatusResetTimer.current);
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
  // Main "save photos to this device" toggle. Enabling it asks for write-only
  // ("Add Photos") library access; if the user declines we leave the toggle
  // off and point them at iOS/Android Settings to change their mind.
  async function handleTogglePersistPhotos(val) {
    if (!val) {
      setPersistPhotosToDevice(false);
      return;
    }
    const granted = await ensureMediaWritePermission({ full: false });
    if (!granted) {
      Alert.alert(
        "Photo Access Needed",
        "To save inspection photos to this device, allow photo access in Settings.",
        [
          { text: "Not Now", style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    setPersistPhotosToDevice(true);
  }

  // Sub-toggle: file saves into a dedicated "Zuba" album. Albums need full
  // (read-write) library access, so this escalates the permission; if the user
  // won't grant full access we keep it off and explain why.
  async function handleToggleAlbum(val) {
    if (!val) {
      setPhotoAlbumEnabled(false);
      return;
    }
    const granted = await ensureMediaWritePermission({ full: true });
    if (!granted) {
      Alert.alert(
        "Full Photo Access Needed",
        "Organizing photos into a Zuba album needs full photo-library access. You can grant it in Settings, or leave this off to save to your camera roll instead.",
        [
          { text: "Not Now", style: "cancel" },
          { text: "Open Settings", onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    setPhotoAlbumEnabled(true);
  }

  const subscriptionStatus = useSubscriptionStore((s) => s.status);
  const refreshSubscription = useSubscriptionStore((s) => s.refreshStatus);
  const clearSubscription = useSubscriptionStore((s) => s.clear);

  async function handleSubscribe() {
    const result = await presentPaywall();
    if (
      result === PAYWALL_RESULT.PURCHASED ||
      result === PAYWALL_RESULT.RESTORED
    ) {
      await refreshSubscription({ sync: true });
    }
  }

  async function handleAddSeats() {
    // Owner already holds the entitlement — present unconditionally so the
    // store sheet can switch them to a bigger seat tier (prorated by Apple).
    await presentPaywallForUpgrade();
    await refreshSubscription({ sync: true });
  }

  async function handleSignOut() {
    try {
      await logOutPurchases();
      await signOutAndClear();
      clearSubscription();
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
    // Apple guideline 5.1.1(v): deleting the account does NOT cancel an App
    // Store subscription, and we're required to say so and point to where it
    // can be cancelled.
    const hasActiveSub =
      subscriptionStatus?.periodEndsAt &&
      Date.parse(subscriptionStatus.periodEndsAt) > Date.now();
    const message =
      "This permanently removes your account. If you're the only member of your organization, all your inspections and photos will also be deleted. This cannot be undone." +
      (hasActiveSub
        ? "\n\nYour App Store subscription is NOT cancelled automatically. To stop future payments, cancel it in your App Store subscription settings."
        : "");
    Alert.alert("Delete Account", message, [
      { text: "Cancel", style: "cancel" },
      ...(hasActiveSub
        ? [{ text: "Manage Subscriptions", onPress: openManageSubscriptions }]
        : []),
      {
        text: "Delete",
        style: "destructive",
        onPress: confirmDeleteAccount,
      },
    ]);
  }

  async function confirmDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    try {
      let data;
      try {
        data = await requestAccountDeletion();
      } catch (invokeErr) {
        logError(
          invokeErr,
          `SettingsScreen.deleteAccount.invoke detail="${invokeErr.message}"`,
        );
        Alert.alert("Delete Failed", invokeErr.message);
        return;
      }
      if (data?.status === "blocked_sole_owner") {
        Alert.alert(
          "Promote Another Owner First",
          data?.message ??
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
      await logOutPurchases();
      await signOutAndClear();
      clearSubscription();
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

        <Text style={styles.sectionLabel}>AI ASSIST</Text>

        <SettingRow
          label="AI Rewrite"
          description="Turn rough notes into report-ready text. A ✨ button appears on multiline note fields; your note is sent to AI for a suggestion you review before using."
          value={aiRewriteEnabled}
          onValueChange={setAiRewriteEnabled}
        />

        <Text style={styles.sectionLabel}>PHOTOS</Text>

        <SettingRow
          label="Save photos to this device"
          description="Also save photos you take to this phone's photo library, on top of the app and the cloud — a personal backup you can view in your gallery. Applies to new photos you take while this is on."
          value={persistPhotosToDevice}
          onValueChange={handleTogglePersistPhotos}
        />

        {persistPhotosToDevice && (
          <SettingRow
            label="Organize in a Zuba album"
            description="Group saved photos into a dedicated “Zuba” album instead of your main camera roll. Needs full photo-library access."
            value={photoAlbumEnabled}
            onValueChange={handleToggleAlbum}
          />
        )}

        <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>

        <NavRow
          label="Notifications"
          description="Choose which push notifications you'd like to receive"
          onPress={() => router.push("/notifications")}
        />

        <Text style={styles.sectionLabel}>CLIENT REMINDERS</Text>

        <SettingRow
          label="Text appointment reminder"
          description="Automatically text clients the day before their inspection to remind them. You can turn this off for an individual inspection when you add or edit it."
          value={apptReminderSmsEnabled}
          onValueChange={setApptReminderSmsEnabled}
        />

        <Guard guard={userProfile === "owner"}>
          <BusinessTimezoneCard orgSk={orgSk} />
        </Guard>

        <Text style={styles.sectionLabel}>MESSAGING</Text>

        <NavRow
          label="SMS Templates"
          description="Create up to 5 pre-written messages for client follow-ups"
          onPress={() => router.push("/smstemplates")}
        />

        <Text style={styles.sectionLabel}>INTEGRATIONS</Text>

        <NavRow
          label="Calendar"
          description="Two-way sync your inspections with your Apple or Google calendar"
          onPress={() => router.push("/calendarsettings")}
        />

        <Text style={styles.sectionLabel}>PAYMENTS & AUTOMATION</Text>
        <Guard guard={userProfile === "owner"}>
          <NavRow
            label="Automatic Document Send"
            description="Auto-send the report when you complete an inspection — plus invoicing and payment-gated reports once payments are set up"
            onPress={() => router.push("/autodocsend")}
          />
          <NavRow
            label="Payment Setup"
            description="Connect Stripe to bill clients, and see your account status"
            onPress={() => router.push("/payments-settings")}
          />
        </Guard>
        <NavRow
          label="Payment Activity"
          description="See payment links you've sent and what clients have paid"
          onPress={() => router.push("/payments")}
        />

        <Guard guard={userProfile === "owner"}>
          <Text style={styles.sectionLabel}>REPORT DESIGNER</Text>
          <FormBuilderCard />
        </Guard>

        <Guard guard={userProfile === "owner" || userProfile === "admin"}>
          <Text style={styles.sectionLabel}>TEAM</Text>
          <Guard guard={userProfile === "owner"}>
            <NavRow
              label="Manage Users"
              description="Set owner, admin, or member access for your organization"
              onPress={() => router.push("/manageusers")}
            />
          </Guard>
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
        </Guard>

        <Text style={styles.sectionLabel}>ARCHIVE</Text>

        <NavRow
          label="Completed Inspections"
          description="View inspections you've marked complete and reopen them if needed"
          onPress={() =>
            router.push({ pathname: "/archive", params: { type: "completed" } })
          }
        />
        <NavRow
          label="Cancelled Inspections"
          description="View inspections clients cancelled by text and restore them if needed"
          badge={cancelCount}
          badgePulse={cancelPulse}
          onPress={() =>
            router.push({ pathname: "/archive", params: { type: "cancelled" } })
          }
        />
        <NavRow
          label="Deleted Inspections"
          description="View deleted inspections and restore them if needed"
          onPress={() =>
            router.push({ pathname: "/archive", params: { type: "deleted" } })
          }
        />

        <SubscriptionSection
          status={subscriptionStatus}
          onSubscribe={handleSubscribe}
          onAddSeats={handleAddSeats}
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

// Org-aware subscription card. The server's subscription-status verdict
// (held in useSubscriptionStore) drives everything here — this component
// never computes plan state itself, it just renders what it's told.
function SubscriptionSection({ status, onSubscribe, onAddSeats }) {
  const [busy, setBusy] = useState(false);
  const isOwner = status?.role === "owner";
  const state = status?.state ?? null;
  const comp = (status?.seats ?? 0) >= 9999;

  async function run(action) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      logError(e, "SettingsScreen.SubscriptionSection");
    } finally {
      setBusy(false);
    }
  }

  let label = "Subscription";
  let description = "Checking your plan…";
  let badge = "—";
  let badgeBg = theme?.colors?.input;
  let badgeFg = theme?.colors?.textSubtle;

  if (state === "trial") {
    label = "Free Trial";
    const d = status?.daysLeft ?? 0;
    description = `${d} ${d === 1 ? "day" : "days"} left — your whole team is included`;
    badge = "TRIAL";
    badgeBg = theme?.colors?.primary;
    badgeFg = "#fff";
  } else if (state === "active") {
    label = "Kensa Pro";
    description = comp
      ? "Complimentary access"
      : isOwner
        ? `${status?.members ?? 0} of ${status?.seats ?? 0} seats in use`
        : "Provided by your organization";
    badge = "PRO";
    badgeBg = theme?.colors?.success;
    badgeFg = "#fff";
  } else if (state === "expired" || state === "seat_locked") {
    label = "Subscription Inactive";
    description = isOwner
      ? "Your free trial has ended — subscribe to keep full access"
      : "Ask your organization owner to subscribe";
    badge = "EXPIRED";
    badgeBg = theme?.colors?.error;
    badgeFg = "#fff";
  }

  return (
    <>
      <Text style={styles.sectionLabel}>SUBSCRIPTION</Text>
      <View style={rowStyles.container}>
        <View style={rowStyles.text}>
          <Text style={rowStyles.label}>{label}</Text>
          <Text style={rowStyles.description}>{description}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: badgeBg }]}>
          <Text style={[styles.badgeText, { color: badgeFg }]}>{badge}</Text>
        </View>
      </View>

      {isOwner && (state === "trial" || state === "expired") && !comp && (
        <NavRow
          label="Subscribe"
          description="One plan covers your whole team — pick the seat count that fits"
          onPress={() => run(onSubscribe)}
        />
      )}
      {isOwner && state === "active" && !comp && status?.seatsExceeded && (
        <NavRow
          label="Add Seats"
          description={`Your team has ${status?.members ?? 0} members but only ${status?.seats ?? 0} ${(status?.seats ?? 0) === 1 ? "seat" : "seats"} — upgrade your plan`}
          onPress={() => run(onAddSeats)}
        />
      )}
      {isOwner && state === "active" && !comp && (
        <NavRow
          label="Manage Subscription"
          description="Change plan, cancel, restore purchases, or get support"
          onPress={() => run(presentCustomerCenter)}
        />
      )}
    </>
  );
}

// Owner-only card that mints/regenerates the secure Form Builder link. The
// raw token only ever lives in the returned URL — the server keeps a hash —
// so we don't persist it on-device; the owner copies/emails it to themselves.
function FormBuilderCard() {
  // 'idle' | 'loading' | 'ready' | 'error'
  const [status, setStatus] = useState("idle");
  const [url, setUrl] = useState(null);

  async function mintLink() {
    if (status === "loading") return;
    setStatus("loading");
    try {
      const { data, error } = await supabase.functions.invoke("form-editor", {
        body: { action: "mint" },
      });
      if (error || !data?.url) throw error ?? new Error("no url returned");
      setUrl(data.url);
      setStatus("ready");
    } catch (e) {
      logError(e, "SettingsScreen.FormBuilderCard.mint");
      setStatus("error");
    }
  }

  function handleRegenerate() {
    Alert.alert(
      "Regenerate Link",
      "This creates a new editor link and permanently disables the old one. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Regenerate", style: "destructive", onPress: mintLink },
      ],
    );
  }

  async function handleShare() {
    try {
      await Share.share({
        message: `Open the Kensa Form Builder in your browser:\n\n${url}`,
      });
    } catch (e) {
      logError(e, "SettingsScreen.FormBuilderCard.share");
    }
  }

  async function handleOpen() {
    try {
      await Linking.openURL(url);
    } catch (e) {
      logError(e, "SettingsScreen.FormBuilderCard.open");
    }
  }

  return (
    <View style={fbStyles.card}>
      <Text style={rowStyles.label}>Form Builder</Text>
      <Text style={rowStyles.description}>
        Design your printable inspection report in a drag-and-drop editor on
        your computer. The link is private to your organization — regenerate it
        any time to revoke the old one.
      </Text>

      {status === "ready" && (
        <Text style={fbStyles.url} numberOfLines={1} selectable>
          {url}
        </Text>
      )}
      {status === "error" && (
        <Text style={fbStyles.error}>
          Couldn't create a link. Check your connection and try again.
        </Text>
      )}

      <View style={fbStyles.btnRow}>
        {status === "ready" ? (
          <>
            <TouchableOpacity style={fbStyles.btn} onPress={handleOpen} activeOpacity={0.7}>
              <MaterialCommunityIcons name="open-in-new" size={15} color={theme.colors.primary} />
              <Text style={fbStyles.btnText}>Open</Text>
            </TouchableOpacity>
            <TouchableOpacity style={fbStyles.btn} onPress={handleShare} activeOpacity={0.7}>
              <MaterialCommunityIcons name="share-variant" size={15} color={theme.colors.primary} />
              <Text style={fbStyles.btnText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={fbStyles.btn} onPress={handleRegenerate} activeOpacity={0.7}>
              <MaterialCommunityIcons name="refresh" size={15} color={theme.colors.primary} />
              <Text style={fbStyles.btnText}>Regenerate</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[fbStyles.btn, fbStyles.btnPrimary]}
            onPress={mintLink}
            activeOpacity={0.8}
            disabled={status === "loading"}
          >
            {status === "loading" ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialCommunityIcons name="link-variant" size={15} color="#fff" />
            )}
            <Text style={[fbStyles.btnText, { color: "#fff" }]}>
              {status === "loading" ? "Creating…" : "Get editor link"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const fbStyles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  url: {
    ...theme.typography.caption,
    color: theme.colors.primary,
    backgroundColor: theme.colors.mainBackground,
    borderRadius: theme.layout.borderRadius.s ?? 8,
    paddingHorizontal: theme.spacing.s,
    paddingVertical: theme.spacing.xs,
    marginTop: theme.spacing.s,
  },
  error: {
    ...theme.typography.caption,
    color: theme.colors.error,
    marginTop: theme.spacing.s,
  },
  btnRow: {
    flexDirection: "row",
    gap: theme.spacing.s,
    marginTop: theme.spacing.s,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.full,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: 6,
  },
  btnPrimary: {
    backgroundColor: theme.colors.primary,
  },
  btnText: {
    ...theme.typography.label,
    color: theme.colors.primary,
    fontWeight: "600",
  },
});

// Curated US business time zones. A short labelled list beats a full IANA
// picker for a US-market app — most inspectors are in one of these.
const US_TIMEZONES = [
  { label: "Eastern", value: "America/New_York" },
  { label: "Central", value: "America/Chicago" },
  { label: "Mountain", value: "America/Denver" },
  { label: "Arizona", value: "America/Phoenix" },
  { label: "Pacific", value: "America/Los_Angeles" },
  { label: "Alaska", value: "America/Anchorage" },
  { label: "Hawaii", value: "Pacific/Honolulu" },
];

function tzLabel(value) {
  return US_TIMEZONES.find((z) => z.value === value)?.label ?? value;
}

// Default to the owner's device zone when it's one we list, else Central.
function detectDefaultTz() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (US_TIMEZONES.some((z) => z.value === tz)) return tz;
  } catch (_) {}
  return "America/Chicago";
}

// Owner-only org-wide business time zone. The day-before SMS reminder job reads
// organizations.timezone server-side to decide each org's "tomorrow" and the
// local send hour, so it must be an org setting (not per-device). Only the owner
// can write it (RLS: auth_uid_owns_org); any seat may read it.
function BusinessTimezoneCard({ orgSk }) {
  const [savedTz, setSavedTz] = useState(null);
  const [detected] = useState(detectDefaultTz);
  // 'loading' | 'idle' | 'saving' | 'error'
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tz = await getOrgTimezone(orgSk);
      if (cancelled) return;
      setSavedTz(tz);
      setStatus("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSk]);

  const active = savedTz ?? detected;

  async function pick(value) {
    if (status === "saving" || value === savedTz) return;
    const prev = savedTz;
    setSavedTz(value); // optimistic
    setStatus("saving");
    try {
      await setOrgTimezone(orgSk, value);
      setStatus("idle");
    } catch (e) {
      logError(e, `SettingsScreen.BusinessTimezoneCard.set tz=${value}`);
      setSavedTz(prev); // revert
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  }

  return (
    <View style={styles.optionCard}>
      <Text style={styles.optionCardLabel}>Business Time Zone</Text>
      <Text style={styles.optionCardDescription}>
        Used to send client appointment reminders at the right local time.
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.optionRow}
      >
        {US_TIMEZONES.map((z) => {
          const selected = active === z.value;
          return (
            <TouchableOpacity
              key={z.value}
              onPress={() => pick(z.value)}
              disabled={status === "loading" || status === "saving"}
              style={[styles.optionBtn, selected && styles.optionBtnSelected]}
            >
              <Text
                style={[
                  styles.optionText,
                  selected && styles.optionTextSelected,
                ]}
              >
                {z.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {status === "error" ? (
        <Text style={styles.tzError}>Couldn't save — tap to try again.</Text>
      ) : savedTz == null && status === "idle" ? (
        <Text style={styles.tzNote}>
          Defaulting to {tzLabel(detected)} — tap to confirm.
        </Text>
      ) : null}
    </View>
  );
}

function NavRow({ label, description, onPress, badge = 0, badgePulse = 0 }) {
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
      <NotificationBadge
        count={badge}
        pulse={badgePulse}
        style={rowStyles.badge}
      />
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
  badge: {
    marginRight: theme.spacing.s,
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
  tzNote: {
    ...theme.typography.caption,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.xs,
  },
  tzError: {
    ...theme.typography.caption,
    color: theme.colors.error,
    marginTop: theme.spacing.xs,
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
