// Push notification scheduling lives here. Each toggle in the Notifications
// settings screen maps to one scheduler function in this file. Keeping them
// in one place means a future "reschedule all" / "cancel all on logout" sweep
// only has to look in one module.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Alert, Platform } from "react-native";
import { logError } from "../db/logs";
import {
    NOTIFICATION_NAMES,
    upsertNotificationSetting,
} from "../db/notificationSettings";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";

// AsyncStorage flag — set the first time the prompt fires so the user is
// never asked again from this device, regardless of their answer.
const UPCOMING_APPT_PROMPT_SEEN_KEY = "notifications_upcomingAppt_prompt_seen";

// Android channel name for appointment reminders. HIGH importance gives us
// heads-up banner + sound + vibration on Android. iOS ignores channel IDs.
const UPCOMING_APPT_CHANNEL_ID = "upcoming-appt";

// Notification data.type marker for tap routing. Keep in sync with the
// handler in app/_layout.jsx — the listener uses this to decide where to
// navigate when the user taps a notification.
const UPCOMING_APPT_DATA_TYPE = "upcomingAppt";

// Foreground display handler. By default expo-notifications suppresses
// notifications while the app is in the foreground; we want banner + sound
// regardless. Setting this at module load is intentional — by the time any
// notification can fire, this module has been imported via _layout.jsx.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Deterministic identifier per inspection so re-scheduling automatically
// dedupes (we cancel-then-schedule using this id below).
function notifIdForInspection(inspectionSk) {
  return `${UPCOMING_APPT_DATA_TYPE}:${inspectionSk}`;
}

// Render the offset minutes as human-friendly copy for the body string.
// 60 → "1 hour"; 90 → "1 hr 30 min"; 30 → "30 minutes".
function formatOffsetForBody(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 60 && m % 60 === 0) {
    const hrs = m / 60;
    return hrs === 1 ? "1 hour" : `${hrs} hours`;
  }
  if (m >= 60) {
    const hrs = Math.floor(m / 60);
    const mins = m % 60;
    return `${hrs} hr ${mins} min`;
  }
  return `${m} minutes`;
}

async function ensureUpcomingApptChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(UPCOMING_APPT_CHANNEL_ID, {
      name: "Appointment Reminders",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      lockscreenVisibility:
        Notifications.AndroidNotificationVisibility?.PUBLIC ?? 1,
    });
  } catch (e) {
    logError(e, "utils/notifications.ensureUpcomingApptChannel");
  }
}

// Cancel a previously-scheduled Upcoming Appointment notification for the
// given inspection. Safe to call even if nothing is scheduled — the OS
// silently ignores unknown ids.
export async function cancelUpcomingApptNotif(inspectionSk) {
  if (!inspectionSk) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(
      notifIdForInspection(inspectionSk),
    );
  } catch (e) {
    // Don't log a hot error for "not found" — the API doesn't distinguish.
    logError(
      e,
      `utils/notifications.cancelUpcomingApptNotif sk=${inspectionSk}`,
    );
  }
}

// Schedule (or re-schedule) a local push reminder for one inspection.
//
// Robustness:
//   - Honors the user's master toggle in the store (off → no-op).
//   - Requires OS permission to be granted (otherwise no-op, no throw).
//   - Validates the inspection has a parseable ScheduledAt in the future.
//   - Only schedules when (apptTime − now) is greater than the offset; if
//     the appointment is too soon, the reminder would fire immediately/late
//     so we skip it.
//   - Idempotent: cancels any existing reminder for the same inspection
//     before scheduling, so calling this twice on the same row never
//     produces two banners.
//   - Logs and returns null on failure rather than throwing — callers
//     looping over many inspections should not be killed by a single bad
//     row.
//
// Returns the scheduled notification identifier, or null if nothing was
// scheduled.
export async function scheduleUpcomingApptNotif({
  inspection,
  scheduleReminderOffset,
} = {}) {
  try {
    if (!inspection?.InspectionSk) return null;

    // Terminal-status gate. A completed/closed OR client-cancelled inspection
    // must never carry a reminder. Checked before the ScheduledAt guard (and
    // before any other gate) so that completing an inspection (INSPECTION_UPDATED
    // with Status='CLOSED') or a client texting "X" (Status='CANCELLED') actively
    // cancels a previously-scheduled reminder rather than silently no-op'ing.
    if (inspection.Status === "CLOSED" || inspection.Status === "CANCELLED") {
      await cancelUpcomingApptNotif(inspection.InspectionSk);
      return null;
    }

    if (!inspection?.ScheduledAt) return null;

    // Master toggle gate — if the user has turned Upcoming Appointment
    // reminders off, do not schedule even if a caller asked us to.
    const store = useSettingsStore.getState();
    const masterOn = !!store?.notifications?.[NOTIFICATION_NAMES.UPCOMING_APPT];
    if (!masterOn) return null;

    // Permission gate.
    const perm = await Notifications.getPermissionsAsync();
    const granted =
      perm?.status === "granted" || perm?.status === "provisional";
    if (!granted) return null;

    // Resolve offset (caller override → store value → 60 default).
    const offsetMin = Number.isFinite(scheduleReminderOffset)
      ? scheduleReminderOffset
      : (store?.scheduleReminderOffsetMinutes ?? 60);
    const offsetMs = Math.max(0, offsetMin) * 60 * 1000;

    // Validate appointment time. Date.parse handles ISO strings; getTime
    // gives ms since epoch in the local clock's reference frame, which is
    // what we want for "is this in the future from right now."
    const apptMs = new Date(inspection.ScheduledAt).getTime();
    if (!Number.isFinite(apptMs)) return null;

    const now = Date.now();
    const msUntilAppt = apptMs - now;
    // "(apptTime - currentTime) > scheduleReminderOffset" per spec — i.e.
    // there must be more time than the offset before the appt or the
    // reminder would have to fire in the past.
    if (msUntilAppt <= offsetMs) return null;

    const deliveryMs = apptMs - offsetMs;
    const deliveryDate = new Date(deliveryMs);

    await ensureUpcomingApptChannel();

    const identifier = notifIdForInspection(inspection.InspectionSk);
    // Cancel any prior scheduled copy for this inspection so re-schedules
    // never double up.
    await cancelUpcomingApptNotif(inspection.InspectionSk);

    const address =
      (typeof inspection.AddressLine1 === "string"
        ? inspection.AddressLine1.trim()
        : "") || "your scheduled location";
    const friendlyOffset = formatOffsetForBody(offsetMin);

    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: "Appointment Reminder",
        body: `Your inspection at ${address} is in ${friendlyOffset}. Tap here to text your client that you are on your way!`,
        sound: "default",
        priority: Notifications.AndroidNotificationPriority?.HIGH ?? "high",
        data: {
          type: UPCOMING_APPT_DATA_TYPE,
          inspectionSk: inspection.InspectionSk,
          fullName: inspection.FullName ?? "",
        },
      },

      trigger: {
        type: Notifications.SchedulableTriggerInputTypes?.DATE ?? "date",
        date: deliveryDate,
        ...(Platform.OS === "android"
          ? { channelId: UPCOMING_APPT_CHANNEL_ID }
          : {}),
      },
    });

    return identifier;
  } catch (e) {
    logError(
      e,
      `utils/notifications.scheduleUpcomingApptNotif sk=${inspection?.InspectionSk ?? "unknown"}`,
    );
    return null;
  }
}

// Tap-routing helper for _layout.jsx. The listener there hands us the raw
// notification response; we pull out the data payload, validate it, and
// hand back navigation instructions (or null to ignore).
//
// Returning a descriptor instead of calling router directly keeps this file
// free of expo-router imports and lets _layout.jsx own all navigation.
export function getUpcomingApptTapRoute(response) {
  try {
    const data = response?.notification?.request?.content?.data ?? null;
    if (!data || data.type !== UPCOMING_APPT_DATA_TYPE) return null;
    const fullName =
      typeof data.fullName === "string" ? data.fullName.trim() : "";
    return {
      pathname: "/(tabs)",
      params: fullName ? { q: fullName } : {},
    };
  } catch (e) {
    logError(e, "utils/notifications.getUpcomingApptTapRoute");
    return null;
  }
}

// Ask the OS for notification permissions. Idempotent — if the user already
// granted, this returns true immediately without prompting again. If they
// previously denied, iOS won't re-prompt and this returns false (the caller
// should send them to Settings).
//
// Returns: { granted: boolean, status: string, canAskAgain: boolean }
//   - granted: true when status is 'granted' (or 'provisional' on iOS)
//   - status:  raw permission status from expo-notifications
//   - canAskAgain: false if iOS has hard-denied and won't show the prompt again
export async function getNotificationPermissions() {
  try {
    // Android requires a channel to be registered before any notification
    // can show — do it here so callers don't have to remember. Channel is a
    // no-op on iOS.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: "default",
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (current.status === "granted" || current.status === "provisional") {
      return {
        granted: true,
        status: current.status,
        canAskAgain: current.canAskAgain ?? true,
      };
    }
    // First-time or undetermined → prompt. iOS won't re-prompt once denied;
    // requestPermissionsAsync just returns the existing 'denied' status.
    if (current.canAskAgain) {
      const next = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
      return {
        granted: next.status === "granted" || next.status === "provisional",
        status: next.status,
        canAskAgain: next.canAskAgain ?? false,
      };
    }
    return {
      granted: false,
      status: current.status,
      canAskAgain: false,
    };
  } catch (e) {
    logError(e, "utils/notifications.getNotificationPermissions");
    return { granted: false, status: "error", canAskAgain: false };
  }
}

// Sweep over every inspection currently in the store and schedule a
// reminder for any that qualify. Used by:
//   - the first-inspection Allow flow (so the just-saved inspection picks
//     up a notification even though it was inserted before the toggle
//     flipped on)
//   - the Settings → Notifications save handler when the user turns the
//     master toggle ON
//   - (future) a boot-time sweep after sync, so cloud-pulled inspections
//     get scheduled on a fresh install
//
// Internally relies on scheduleUpcomingApptNotif's own gates — permission,
// master toggle, "more than offset in the future" — so this is safe to
// call even when the toggle isn't on; it'll just no-op cheaply per row.
//
// Returns a summary so callers can log / diagnose.
export async function rescheduleAllUpcomingApptNotifs() {
  try {
    // Short-circuit on toggle / permission so we don't iterate the store
    // for nothing on a no-op call (e.g. user dismissed the prompt).
    const settings = useSettingsStore.getState();
    const masterOn =
      !!settings?.notifications?.[NOTIFICATION_NAMES.UPCOMING_APPT];
    if (!masterOn) return { scheduled: 0, skipped: 0, masterOff: true };

    const perm = await Notifications.getPermissionsAsync();
    const granted =
      perm?.status === "granted" || perm?.status === "provisional";
    if (!granted) return { scheduled: 0, skipped: 0, noPermission: true };

    const inspState = useInspectionStore.getState();
    const inspectionsMap = inspState?.inspections ?? {};
    const ids = inspState?.sortedIds ?? [];

    let scheduled = 0;
    let skipped = 0;
    for (const id of ids) {
      const insp = inspectionsMap[id];
      if (!insp) {
        skipped++;
        continue;
      }
      // scheduleUpcomingApptNotif applies the future-time / offset gate
      // itself, so we don't need to pre-filter here.
      // eslint-disable-next-line no-await-in-loop
      const result = await scheduleUpcomingApptNotif({ inspection: insp });
      if (result) scheduled++;
      else skipped++;
    }
    return { scheduled, skipped };
  } catch (e) {
    logError(e, "utils/notifications.rescheduleAllUpcomingApptNotifs");
    return { scheduled: 0, skipped: 0, error: true };
  }
}

// Cancel every scheduled Upcoming Appointment notification on this device.
// Reads the OS list directly (rather than tracking locally) so it stays in
// sync even if we ever lose track — e.g. a previous build scheduled some
// and we re-install without that local state.
//
// Filters by our `upcomingAppt:` identifier prefix so we never touch
// notifications another feature may schedule in the future.
//
// Returns the number cancelled.
export async function cancelAllUpcomingApptNotifs() {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const prefix = `${UPCOMING_APPT_DATA_TYPE}:`;
    const ours = (all ?? []).filter(
      (n) =>
        typeof n?.identifier === "string" && n.identifier.startsWith(prefix),
    );
    for (const n of ours) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      } catch (e) {
        logError(
          e,
          `utils/notifications.cancelAllUpcomingApptNotifs id=${n.identifier}`,
        );
      }
    }
    return ours.length;
  } catch (e) {
    logError(e, "utils/notifications.cancelAllUpcomingApptNotifs");
    return 0;
  }
}

// Persist the Upcoming Appointment toggle through SQLite + the store (which
// also writes AsyncStorage). Notifications are device-local, so we do not
// sync this to the cloud.
async function saveUpcomingApptToggle(userSk, value) {
  try {
    await upsertNotificationSetting(
      userSk,
      NOTIFICATION_NAMES.UPCOMING_APPT,
      value,
    );
    const store = useSettingsStore.getState();
    await store.setNotifications({
      ...(store.notifications ?? {}),
      [NOTIFICATION_NAMES.UPCOMING_APPT]: value,
    });
  } catch (e) {
    logError(e, `utils/notifications.saveUpcomingApptToggle userSk=${userSk}`);
  }
}

// One-time prompt that fires after the user creates their first inspection.
// Sets the AsyncStorage flag immediately so a quick interrupt (app crash,
// double-tap) can't trigger a re-prompt. Resolves when the user picks an
// option so the caller can defer navigation until the dialog clears.
export async function maybePromptForUpcomingApptNotif({ userSk } = {}) {
  try {
    const seen = await AsyncStorage.getItem(UPCOMING_APPT_PROMPT_SEEN_KEY);
    if (seen === "1") return;
    await AsyncStorage.setItem(UPCOMING_APPT_PROMPT_SEEN_KEY, "1");

    return await new Promise((resolve) => {
      Alert.alert(
        "Enable Reminders",
        "Allow Zanbi to send local reminders for your scheduled property and roof assessments. You can change notification settings in Settings > Notifications at any time.",
        [
          {
            text: "Not Now",
            style: "cancel",
            onPress: () => resolve(false),
          },
          {
            text: "Allow",
            onPress: async () => {
              try {
                const result = await getNotificationPermissions();
                if (result.granted && userSk) {
                  await saveUpcomingApptToggle(userSk, true);
                  // Sweep so the inspection the user JUST created (and any
                  // others already in the store) get scheduled — the
                  // INSPECTION_INSERTED event fired before the toggle was
                  // on, so the per-row schedule no-op'd. Fire-and-forget;
                  // we don't make the user wait on the OS round-trip.
                  rescheduleAllUpcomingApptNotifs().catch((e) =>
                    logError(
                      e,
                      "utils/notifications.maybePromptForUpcomingApptNotif.sweep",
                    ),
                  );
                }
                resolve(true);
              } catch (e) {
                logError(
                  e,
                  "utils/notifications.maybePromptForUpcomingApptNotif.allow",
                );
                resolve(false);
              }
            },
          },
        ],
        { cancelable: false },
      );
    });
  } catch (e) {
    logError(e, "utils/notifications.maybePromptForUpcomingApptNotif");
  }
}
