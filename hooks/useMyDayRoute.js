// useMyDayRoute — fetches the My Day dashboard route summary from the
// my-day-route Edge Function. Handles foreground location permission,
// inflight de-dupe, and surfaces network failures through the global
// banner so the dashboard doesn't need to repeat that plumbing.
//
// API:
//   const { data, loading, error, refresh } = useMyDayRoute({ enabled });
//
// `data` shape mirrors the Edge Function payload (see supabase/functions/
// my-day-route/index.ts):
//   { mode, nextStop, dailyTotals, summary, fetchedAt, fromCache }

import dayjs from "dayjs";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { logError } from "../db/logs";
import { showBanner } from "../stores/useBannerStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { supabase } from "../utils/supabase";

export function useMyDayRoute({ enabled = true } = {}) {
  const apptLengthMinutes = useSettingsStore((s) => s.apptLengthMinutes);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inflightRef = useRef(false);

  const fetchRoute = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    setError(null);

    try {
      // 1. Foreground location permission. Request once; if denied, surface
      // via banner and exit. Caller can call refresh() to try again after
      // the user grants in Settings.
      const existing = await Location.getForegroundPermissionsAsync();
      let granted = existing?.status === "granted";
      if (!granted && existing?.canAskAgain) {
        const req = await Location.requestForegroundPermissionsAsync();
        granted = req?.status === "granted";
      }
      if (!granted) {
        setError({ kind: "no_location_permission" });
        showBanner({
          message: "Enable location to see drive times and traffic.",
          kind: "warning",
          duration: 5000,
        });
        return;
      }

      // 2. One-shot fix. Balanced accuracy is plenty for a city-block
      // route start; saves battery vs. High.
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const currentLocation = {
        lat: loc?.coords?.latitude,
        lng: loc?.coords?.longitude,
      };
      if (
        typeof currentLocation.lat !== "number" ||
        typeof currentLocation.lng !== "number"
      ) {
        setError({ kind: "no_location_fix" });
        return;
      }

      // 3. Local-day window in ISO. The Edge Function uses these as a
      // WHERE clause on scheduled_at — sending the window from the client
      // means we don't need to know the user's TZ on the server.
      const startOfDay = dayjs().startOf("day").toISOString();
      const endOfDay = dayjs().endOf("day").toISOString();

      // 4. Invoke.
      const { data: resp, error: invokeErr } =
        await supabase.functions.invoke("my-day-route", {
          body: {
            currentLocation,
            apptLengthMinutes,
            localDateStart: startOfDay,
            localDateEnd: endOfDay,
          },
        });

      if (invokeErr) {
        logError(invokeErr, "useMyDayRoute.invoke");
        setError({ kind: "fetch_failed", detail: invokeErr?.message });
        showBanner({
          message: "Sync network not ready. Pull down on My Day to refresh.",
          kind: "warning",
          duration: 4500,
        });
        return;
      }

      if (resp?.error) {
        setError({ kind: resp.error, detail: resp.detail });
        // Specific error codes get tailored copy; generic ones fall back.
        if (resp.error === "routes_api_failed") {
          showBanner({
            message: "Couldn't reach routing service. Try again in a minute.",
            kind: "error",
            duration: 4500,
          });
        }
        return;
      }

      setData(resp);
    } catch (e) {
      logError(e, "useMyDayRoute.fetchRoute");
      setError({ kind: "exception", detail: e?.message });
    } finally {
      setLoading(false);
      inflightRef.current = false;
    }
  }, [apptLengthMinutes]);

  useEffect(() => {
    if (!enabled) return;
    fetchRoute();
  }, [enabled, fetchRoute]);

  return { data, loading, error, refresh: fetchRoute };
}
