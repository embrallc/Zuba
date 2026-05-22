import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { logError } from "../db/logs";

const KEYS = {
  showWeekends: "settings_showWeekends",
  cloudStorage: "settings_cloudStorage",
  userSk: "user_sk",
  apptLengthMinutes: "settings_apptLengthMinutes",
  calendarStartHour: "settings_calendarStartHour",
};

export const useSettingsStore = create((set) => ({
  showWeekends: false,
  cloudStorageEnabled: false,
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

  loadSettings: async () => {
    try {
      const [showWeekends, cloudStorage, userSk, apptLength, startHour] =
        await Promise.all([
          AsyncStorage.getItem(KEYS.showWeekends),
          AsyncStorage.getItem(KEYS.cloudStorage),
          AsyncStorage.getItem(KEYS.userSk),
          AsyncStorage.getItem(KEYS.apptLengthMinutes),
          AsyncStorage.getItem(KEYS.calendarStartHour),
        ]);
      set({
        showWeekends: showWeekends ? JSON.parse(showWeekends) : false,
        cloudStorageEnabled: cloudStorage ? JSON.parse(cloudStorage) : false,
        userSk: userSk ?? null,
        apptLengthMinutes: apptLength ? JSON.parse(apptLength) : 60,
        calendarStartHour: startHour ? JSON.parse(startHour) : 7,
      });
    } catch (e) {
      logError(e, "useSettingsStore.loadSettings");
      throw e;
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

  setCloudStorageEnabled: async (val) => {
    try {
      set({ cloudStorageEnabled: val });
      await AsyncStorage.setItem(KEYS.cloudStorage, JSON.stringify(val));
    } catch (e) {
      logError(e, `useSettingsStore.setCloudStorageEnabled val=${val}`);
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
