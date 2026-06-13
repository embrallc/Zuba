import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
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

export const useSettingsStore = create((set) => ({
  showWeekends: false,
  userSk: null,
  // Cached from session.user_metadata at login. Authoritative copy lives on
  // the cloud users row + auth.users.raw_user_meta_data; this is just for
  // client-side UX gating (e.g. showing the Manage Users settings row).
  userProfile: null,
  orgSk: null,
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

  loadSettings: async () => {
    try {
      const [
        showWeekends,
        userSk,
        apptLength,
        startHour,
        notifications,
        integrations,
      ] = await Promise.all([
        AsyncStorage.getItem(KEYS.showWeekends),
        AsyncStorage.getItem(KEYS.userSk),
        AsyncStorage.getItem(KEYS.apptLengthMinutes),
        AsyncStorage.getItem(KEYS.calendarStartHour),
        AsyncStorage.getItem(KEYS.notifications),
        AsyncStorage.getItem(KEYS.integrations),
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
      });
    } catch (e) {
      logError(e, "useSettingsStore.loadSettings");
      throw e;
    }
  },

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

  setFname: (val) => {
    set({ fname: val });
  },

  setLname: (val) => {
    set({ lname: val });
  },
}));
