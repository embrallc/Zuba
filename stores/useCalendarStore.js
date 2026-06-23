import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { create } from "zustand";
import { logError } from "../db/logs";

// Device-local calendar-sync config. NOT synced to the cloud — the chosen
// system calendar is per-device (a phone and a tablet pick different ones), so
// this lives only in AsyncStorage. The per-inspection link (CalendarEventId /
// CalendarOwnerDeviceId / CalendarSnapshot) is what syncs; see utils/sync.js.
//
// deviceId is a stable per-install UUID minted once here (via expo-crypto, which
// db/inspections already depends on — no new native module). It's the
// single-writer key: only the device that owns an inspection's calendar event
// pushes updates/deletes for it.

const KEY = "calendar_config_v1";

const DEFAULTS = {
  enabled: false, // master Calendar Sync toggle
  push: true, // push inspections → calendar
  pull: true, // pull #zuba events → inspections
  calendarId: null, // chosen system-calendar id
  calendarTitle: null, // for display in Settings
  sourceName: null, // account/source name for display
};

export const useCalendarStore = create((set, get) => ({
  ...DEFAULTS,
  deviceId: null,
  hydrated: false,

  // Read config from AsyncStorage; mint + persist a deviceId on first run.
  // Call once at boot (after the DB is open) from app/_layout.jsx.
  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      let deviceId = parsed.deviceId;
      let minted = false;
      if (!deviceId) {
        deviceId = Crypto.randomUUID();
        minted = true;
      }
      const next = { ...DEFAULTS, ...parsed, deviceId };
      set({ ...next, hydrated: true });
      if (minted) await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) {
      logError(e, "useCalendarStore.load");
      // Don't let the fallback throw too (e.g. if randomUUID is the culprit) —
      // a null deviceId just means sync stays unconfigured until next load.
      let id = null;
      try {
        id = Crypto.randomUUID();
      } catch (_) {}
      set({ ...DEFAULTS, deviceId: id, hydrated: true });
    }
  },

  // Merge a partial config and persist the whole blob (incl. deviceId).
  update: async (partial) => {
    try {
      const prev = get();
      const next = {
        enabled: prev.enabled,
        push: prev.push,
        pull: prev.pull,
        calendarId: prev.calendarId,
        calendarTitle: prev.calendarTitle,
        sourceName: prev.sourceName,
        deviceId: prev.deviceId,
        ...partial,
      };
      set(partial);
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) {
      logError(e, "useCalendarStore.update");
    }
  },
}));
