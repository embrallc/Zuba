import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { getUnviewedCancelledCount } from "../db/inspections";
import { logError } from "../db/logs";
import {
  listNotificationSettings,
  NOTIFICATION_NAMES,
} from "../db/notificationSettings";

const KEYS = {
  showWeekends: "settings_showWeekends",
  userSk: "user_sk",
  apptLengthMinutes: "settings_apptLengthMinutes",
  calendarStartHour: "settings_calendarStartHour",
  notifications: "settings_notifications",
  integrations: "settings_integrations",
  aiRewrite: "settings_aiRewriteEnabled",
  apptReminderSms: "settings_apptReminderSmsEnabled",
  persistPhotos: "settings_persistPhotosToDevice",
  photoAlbum: "settings_photoAlbumEnabled",
  cancelledViewedAt: "settings_cancelledViewedAt",
};

// Default OFF until the user opts in.
const DEFAULT_NOTIFICATIONS = {
  [NOTIFICATION_NAMES.UPCOMING_APPT]: false,
};

// Map of integration name → boolean. Each represents an external service the
// user can hook into Kensa from Settings → Integrations. All default OFF.
const DEFAULT_INTEGRATIONS = {
  appleCalendar: false,
  googleCalendar: false,
};

export const useSettingsStore = create((set, get) => ({
  showWeekends: false,
  userSk: null,
  // Cached from session.user_metadata at login. Authoritative copy lives on
  // the cloud users row + auth.users.raw_user_meta_data; this is just for
  // client-side UX gating (e.g. showing the Manage Users settings row).
  userProfile: null,
  orgSk: null,
  // Cached org-level "invoicing is live" flag (organizations.stripe_charges_enabled).
  // The org row isn't synced to SQLite, so it's fetched at boot (see _layout
  // loadUserData) and refreshed from the Payments screen. In-memory only — it's
  // per-org server truth re-fetched each session, NOT persisted (keeps a stale
  // value from bleeding across users on a shared device). Drives invoice-button
  // visibility: once live every role sees it; before setup only owner/admin see
  // the upsell. Any org member can read the flag (org SELECT RLS is role-agnostic).
  paymentsLive: false,
  fname: null,
  lname: null,
  apptLengthMinutes: 60,
  calendarStartHour: 7,
  // Map of NotificationName → boolean. Mirrors the NotificationSettings rows
  // for the current user. UI screens treat absent keys as `false`.
  notifications: { ...DEFAULT_NOTIFICATIONS },
  // Map of integration name → boolean (e.g. appleCalendar, googleCalendar).
  // Mirrors `notifications` shape so additional integrations slot in without
  // a store change. UI screens treat absent keys as `false`.
  integrations: { ...DEFAULT_INTEGRATIONS },
  // Minutes before an appointment that an Upcoming Appointment reminder
  // should fire. Hard-coded for now; a Settings picker will land later.
  scheduleReminderOffsetMinutes: 60,
  // Opt-in: show the ✨ Rewrite affordance on multiline note fields, which
  // sends the note text to Gemini (via the ai-rewrite edge function) for a
  // report-ready suggestion the inspector reviews before using. Default OFF.
  aiRewriteEnabled: false,
  // Default for the day-before client SMS appointment reminder. Seeds each new
  // inspection's HasApptReminder; the per-inspection toggle in Add/Edit overrides
  // it. Default OFF — it's opt-in (costs an SMS and needs client consent).
  apptReminderSmsEnabled: false,
  // Opt-in: also save camera-captured inspection photos to the device's photo
  // library (on top of the app cache + cloud bucket). Device-local — a storage
  // preference for THIS phone, so it never rides the cloud users row. Default OFF.
  persistPhotosToDevice: false,
  // When persistPhotosToDevice is on, route saves into a dedicated "Zuba" album
  // instead of the plain camera roll. Needs full (read-write) library access, so
  // it's a second opt-in revealed only after the main toggle is granted. Default OFF.
  photoAlbumEnabled: false,

  // Unread-cancellation badge. cancelledViewedAt = epoch-ms of the last time the
  // user opened the Cancelled archive; unviewedCancelledCount = CANCELLED rows
  // whose cancellation is newer than that (derived from SQLite, not persisted).
  // cancelBadgePulseKey: bump it to replay the badge's attention bounce
  // (on app-enter + on entering Settings).
  cancelledViewedAt: 0,
  unviewedCancelledCount: 0,
  cancelBadgePulseKey: 0,

  loadSettings: async () => {
    try {
      const [
        showWeekends,
        userSk,
        apptLength,
        startHour,
        notifications,
        integrations,
        aiRewrite,
        apptReminderSms,
        persistPhotos,
        photoAlbum,
        cancelledViewedAt,
      ] = await Promise.all([
        AsyncStorage.getItem(KEYS.showWeekends),
        AsyncStorage.getItem(KEYS.userSk),
        AsyncStorage.getItem(KEYS.apptLengthMinutes),
        AsyncStorage.getItem(KEYS.calendarStartHour),
        AsyncStorage.getItem(KEYS.notifications),
        AsyncStorage.getItem(KEYS.integrations),
        AsyncStorage.getItem(KEYS.aiRewrite),
        AsyncStorage.getItem(KEYS.apptReminderSms),
        AsyncStorage.getItem(KEYS.persistPhotos),
        AsyncStorage.getItem(KEYS.photoAlbum),
        AsyncStorage.getItem(KEYS.cancelledViewedAt),
      ]);
      set({
        showWeekends: showWeekends ? JSON.parse(showWeekends) : false,
        userSk: userSk ?? null,
        apptLengthMinutes: apptLength ? JSON.parse(apptLength) : 60,
        calendarStartHour: startHour ? JSON.parse(startHour) : 7,
        notifications: notifications
          ? { ...DEFAULT_NOTIFICATIONS, ...JSON.parse(notifications) }
          : { ...DEFAULT_NOTIFICATIONS },
        integrations: integrations
          ? { ...DEFAULT_INTEGRATIONS, ...JSON.parse(integrations) }
          : { ...DEFAULT_INTEGRATIONS },
        aiRewriteEnabled: aiRewrite ? JSON.parse(aiRewrite) : false,
        apptReminderSmsEnabled: apptReminderSms
          ? JSON.parse(apptReminderSms)
          : false,
        persistPhotosToDevice: persistPhotos
          ? JSON.parse(persistPhotos)
          : false,
        photoAlbumEnabled: photoAlbum ? JSON.parse(photoAlbum) : false,
        cancelledViewedAt: cancelledViewedAt
          ? JSON.parse(cancelledViewedAt)
          : 0,
      });
    } catch (e) {
      logError(e, "useSettingsStore.loadSettings");
      throw e;
    }
  },

  // Recompute the unread-cancellation count from SQLite (CANCELLED rows newer
  // than cancelledViewedAt). Call after the DB opens and whenever inspections
  // change (DB_EVENTS.INSPECTION_UPDATED / the Realtime cancel handler).
  refreshCancelledCount: async () => {
    try {
      const n = await getUnviewedCancelledCount(get().cancelledViewedAt);
      set({ unviewedCancelledCount: n });
    } catch (e) {
      logError(e, "useSettingsStore.refreshCancelledCount");
    }
  },

  // The user opened the Cancelled archive → everything is now "seen". Stamp the
  // watermark forward and clear the badge.
  markCancellationsViewed: async () => {
    try {
      const now = Date.now();
      set({ cancelledViewedAt: now, unviewedCancelledCount: 0 });
      await AsyncStorage.setItem(KEYS.cancelledViewedAt, JSON.stringify(now));
    } catch (e) {
      logError(e, "useSettingsStore.markCancellationsViewed");
    }
  },

  // Replay the badge attention bounce (app-enter + entering Settings).
  bumpCancelBadgePulse: () =>
    set((s) => ({ cancelBadgePulseKey: s.cancelBadgePulseKey + 1 })),

  // Hydrate the notifications map from the SQLite NotificationSettings table.
  // SQLite is the authoritative local copy (cloud sync writes to it); AsyncStorage
  // is just a fast bootstrap cache. Call from _layout after the DB is opened.
  loadNotificationsFromDb: async (userId) => {
    try {
      if (!userId) return;
      const rows = await listNotificationSettings(userId);
      const next = { ...DEFAULT_NOTIFICATIONS };
      for (const r of rows) {
        next[r.NotificationName] = !!r.IsNotificationOn;
      }
      set({ notifications: next });
      await AsyncStorage.setItem(KEYS.notifications, JSON.stringify(next));
    } catch (e) {
      logError(e, `useSettingsStore.loadNotificationsFromDb userId=${userId}`);
    }
  },

  // Replace the whole notifications map (the Save action on the screen builds
  // the full object before calling this). Persists to AsyncStorage; SQLite +
  // cloud writes are handled by the screen so it can show save status.
  setNotifications: async (next) => {
    try {
      set({ notifications: next });
      await AsyncStorage.setItem(KEYS.notifications, JSON.stringify(next));
    } catch (e) {
      logError(e, "useSettingsStore.setNotifications");
    }
  },

  // Replace the whole integrations map (Settings → Integrations toggles call
  // this with the full next state). Device-local — no cloud sync, since
  // calendar/etc. integration is per-device (different calendars per phone).
  setIntegrations: async (next) => {
    try {
      set({ integrations: next });
      await AsyncStorage.setItem(KEYS.integrations, JSON.stringify(next));
    } catch (e) {
      logError(e, "useSettingsStore.setIntegrations");
    }
  },

  setShowWeekends: async (val) => {
    try {
      set({ showWeekends: val });
      await AsyncStorage.setItem(KEYS.showWeekends, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setShowWeekends val=${val}`);
    }
  },

  setAiRewriteEnabled: async (val) => {
    try {
      set({ aiRewriteEnabled: val });
      await AsyncStorage.setItem(KEYS.aiRewrite, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setAiRewriteEnabled val=${val}`);
    }
  },

  setApptReminderSmsEnabled: async (val) => {
    try {
      set({ apptReminderSmsEnabled: val });
      await AsyncStorage.setItem(KEYS.apptReminderSms, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setApptReminderSmsEnabled val=${val}`);
    }
  },

  setPersistPhotosToDevice: async (val) => {
    try {
      set({ persistPhotosToDevice: val });
      await AsyncStorage.setItem(KEYS.persistPhotos, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setPersistPhotosToDevice val=${val}`);
    }
  },

  setPhotoAlbumEnabled: async (val) => {
    try {
      set({ photoAlbumEnabled: val });
      await AsyncStorage.setItem(KEYS.photoAlbum, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setPhotoAlbumEnabled val=${val}`);
    }
  },

  setApptLengthMinutes: async (val) => {
    try {
      set({ apptLengthMinutes: val });
      await AsyncStorage.setItem(KEYS.apptLengthMinutes, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setApptLengthMinutes val=${val}`);
    }
  },

  setCalendarStartHour: async (val) => {
    try {
      set({ calendarStartHour: val });
      await AsyncStorage.setItem(KEYS.calendarStartHour, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setCalendarStartHour val=${val}`);
    }
  },

  setUserSk: (sk) => {
    set({ userSk: sk });
  },

  setUserProfile: (val) => {
    set({ userProfile: val });
  },

  setOrgSk: (val) => {
    set({ orgSk: val });
  },

  setPaymentsLive: (val) => {
    set({ paymentsLive: !!val });
  },

  setFname: (val) => {
    set({ fname: val });
  },

  setLname: (val) => {
    set({ lname: val });
  },
}));
