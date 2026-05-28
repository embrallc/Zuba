// MyDayDashboard — top card on the (tabs)/index "My Day" screen.
//
// Pure presentational; the parent owns data fetching via useMyDayRoute and
// passes the unwrapped state down. Handles four visual states:
//   1. Loading (skeleton)
//   2. Error / no-permission (gentle hint + retry button)
//   3. Done (no remaining inspections today)
//   4. Active (next stop block + daily totals)

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { AnimatePresence, MotiView } from "moti";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const TRAFFIC_META = {
  light: {
    label: "Light traffic",
    color: theme?.colors?.success ?? "#16A34A",
    icon: "speedometer-slow",
  },
  moderate: {
    label: "Moderate traffic",
    color: theme?.colors?.warning ?? "#D97706",
    icon: "speedometer-medium",
  },
  heavy: {
    label: "Heavy traffic",
    color: theme?.colors?.error ?? "#DC2626",
    icon: "speedometer",
  },
};

function metersToMiles(m) {
  return m / 1609.344;
}

function formatMinutes(totalSec) {
  const min = Math.max(0, Math.round((totalSec ?? 0) / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (rem === 0) return `${h} hr`;
  return `${h} hr ${rem} min`;
}

function formatMiles(m) {
  const mi = metersToMiles(m ?? 0);
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

function formatTime(iso) {
  if (!iso) return "—";
  return dayjs(iso).format("h:mm A");
}

function relativeUpdated(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min === 1) return "1 min ago";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h === 1 ? "1 hr ago" : `${h} hr ago`;
}

export default function MyDayDashboard({ data, loading, error, onRefresh }) {
  // Loading state — skeleton with a spinner.
  if (loading && !data) {
    return (
      <View style={styles.card}>
        <View style={styles.center}>
          <ActivityIndicator size="small" color={theme?.colors?.primary} />
          <Text style={styles.muted}>Loading your day…</Text>
        </View>
      </View>
    );
  }

  // Error / no-permission state.
  if (error && !data) {
    const isPermission = error.kind === "no_location_permission";
    return (
      <View style={styles.card}>
        <View style={styles.center}>
          <MaterialCommunityIcons
            name={isPermission ? "map-marker-off-outline" : "wifi-off"}
            size={28}
            color={theme?.colors?.textFine}
          />
          <Text style={styles.errorTitle}>
            {isPermission
              ? "Location needed"
              : "Couldn't load your day"}
          </Text>
          <Text style={styles.muted}>
            {isPermission
              ? "Enable location to see drive times and traffic."
              : "Tap retry or pull down to refresh."}
          </Text>
          <TouchableOpacity
            onPress={onRefresh}
            style={styles.retryBtn}
            activeOpacity={0.75}
          >
            <MaterialCommunityIcons
              name="refresh"
              size={16}
              color={theme?.colors?.primary}
            />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Done state.
  if (data?.mode === "done") {
    return (
      <View style={styles.card}>
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="check-circle-outline"
            size={32}
            color={theme?.colors?.success}
          />
          <Text style={styles.doneTitle}>
            {data?.dailyTotals?.totalToday > 0
              ? "All inspections complete!"
              : "No inspections today"}
          </Text>
          <Text style={styles.muted}>
            {data?.dailyTotals?.totalToday > 0
              ? "Nice work — enjoy the rest of your day."
              : "Tap the + button to schedule one."}
          </Text>
        </View>
      </View>
    );
  }

  // Active state — render only when we have a payload.
  if (!data?.nextStop) {
    return (
      <View style={styles.card}>
        <View style={styles.center}>
          <ActivityIndicator size="small" color={theme?.colors?.primary} />
        </View>
      </View>
    );
  }

  const { nextStop, dailyTotals, fetchedAt, mode } = data;
  const trafficMeta = TRAFFIC_META[nextStop.trafficLevel] ?? TRAFFIC_META.moderate;
  const isLate = (nextStop.lateByMinutes ?? 0) > 0;

  return (
    <AnimatePresence>
      <MotiView
        from={{ opacity: 0, translateY: 6 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 260 }}
        style={styles.card}
      >
        {/* Header: mode label + refresh */}
        <View style={styles.headerRow}>
          <View style={styles.modePill}>
            <View
              style={[
                styles.modeDot,
                {
                  backgroundColor:
                    mode === "in-progress"
                      ? theme?.colors?.warning
                      : theme?.colors?.primary,
                },
              ]}
            />
            <Text style={styles.modeText}>
              {mode === "in-progress" ? "In progress" : "Up next"}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onRefresh}
            hitSlop={theme?.layout?.hitSlop?.medium}
            style={styles.refreshIcon}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons
              name="refresh"
              size={18}
              color={theme?.colors?.textSubtle}
            />
          </TouchableOpacity>
        </View>

        {/* Next stop */}
        <View style={styles.nextStopRow}>
          <Text style={styles.nextStopName} numberOfLines={1}>
            {nextStop.fullName}
          </Text>
          <Text style={styles.nextStopTime}>
            {formatTime(nextStop.scheduledAt)}
          </Text>
        </View>
        {!!nextStop.address && (
          <Text style={styles.nextStopAddress} numberOfLines={1}>
            {nextStop.address}
          </Text>
        )}

        {/* Drive metrics row */}
        <View style={styles.metricsRow}>
          <View style={styles.metric}>
            <MaterialCommunityIcons
              name="car-outline"
              size={18}
              color={theme?.colors?.primary}
            />
            <Text style={styles.metricValue}>
              {formatMinutes(nextStop.driveDurationSec)}
            </Text>
            <Text style={styles.metricLabel}>drive</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <MaterialCommunityIcons
              name="map-marker-distance"
              size={18}
              color={theme?.colors?.primary}
            />
            <Text style={styles.metricValue}>
              {formatMiles(nextStop.driveDistanceMeters)}
            </Text>
            <Text style={styles.metricLabel}>away</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <MaterialCommunityIcons
              name={trafficMeta.icon}
              size={18}
              color={trafficMeta.color}
            />
            <Text style={[styles.metricValue, { color: trafficMeta.color }]}>
              {nextStop.trafficLevel === "light"
                ? "Light"
                : nextStop.trafficLevel === "heavy"
                  ? "Heavy"
                  : "Moderate"}
            </Text>
            <Text style={styles.metricLabel}>traffic</Text>
          </View>
        </View>

        {/* ETA / late line */}
        <View style={styles.etaRow}>
          <MaterialCommunityIcons
            name={isLate ? "alert-circle-outline" : "clock-check-outline"}
            size={16}
            color={isLate ? theme?.colors?.error : theme?.colors?.success}
          />
          <Text
            style={[
              styles.etaText,
              { color: isLate ? theme?.colors?.error : theme?.colors?.text },
            ]}
          >
            {isLate
              ? `Running ${nextStop.lateByMinutes} min late — ETA ${formatTime(nextStop.etaIso)}`
              : `On time — ETA ${formatTime(nextStop.etaIso)}`}
          </Text>
        </View>

        {/* Daily totals */}
        {dailyTotals ? (
          <View style={styles.totalsBlock}>
            <View style={styles.totalsRow}>
              <View style={styles.totalsItem}>
                <Text style={styles.totalsLabel}>Day Start</Text>
                <Text style={styles.totalsValue}>
                  {formatTime(dailyTotals.dayStartIso)}
                </Text>
              </View>
              <View style={styles.totalsItem}>
                <Text style={styles.totalsLabel}>Day End</Text>
                <Text style={styles.totalsValue}>
                  {formatTime(dailyTotals.dayEndIso)}
                </Text>
              </View>
              <View style={styles.totalsItem}>
                <Text style={styles.totalsLabel}>Total Drive</Text>
                <Text style={styles.totalsValue}>
                  {formatMinutes(dailyTotals.totalDriveSec)}
                </Text>
              </View>
              <View style={styles.totalsItem}>
                <Text style={styles.totalsLabel}>Miles</Text>
                <Text style={styles.totalsValue}>
                  {formatMiles(dailyTotals.totalDistanceMeters)}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Footer */}
        <Text style={styles.footer}>
          Updated {relativeUpdated(fetchedAt)}
          {data?.fromCache ? " · cached" : ""}
        </Text>
      </MotiView>
    </AnimatePresence>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.l ?? 20,
    padding: theme?.spacing?.m,
    ...(theme?.shadows?.medium ?? {}),
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.s ?? 8,
    paddingHorizontal: theme?.spacing?.l ?? 24,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: theme?.colors?.primaryGhost ?? "rgba(92,92,232,0.10)",
  },
  modeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  modeText: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.primary,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  refreshIcon: {
    padding: 4,
  },
  nextStopRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: theme?.spacing?.s,
    gap: theme?.spacing?.s,
  },
  nextStopName: {
    ...(theme?.typography?.h3 ?? {}),
    flex: 1,
  },
  nextStopTime: {
    ...(theme?.typography?.bodyBold ?? {}),
    color: theme?.colors?.primary,
  },
  nextStopAddress: {
    ...(theme?.typography?.label ?? {}),
    color: theme?.colors?.textSubtle,
    marginTop: 2,
  },
  metricsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.s,
    paddingHorizontal: theme?.spacing?.s,
    backgroundColor: theme?.colors?.mainBackground,
    borderRadius: theme?.layout?.borderRadius?.m ?? 14,
  },
  metric: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  metricValue: {
    ...(theme?.typography?.bodyBold ?? {}),
    fontSize: 14,
  },
  metricLabel: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.textFine,
  },
  metricDivider: {
    width: 1,
    height: 28,
    backgroundColor: theme?.colors?.input,
  },
  etaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: theme?.spacing?.s,
  },
  etaText: {
    ...(theme?.typography?.body ?? {}),
    fontSize: 13,
  },
  totalsBlock: {
    marginTop: theme?.spacing?.m,
    paddingTop: theme?.spacing?.s,
    borderTopWidth: theme?.layout?.borderWidth?.thin,
    borderTopColor: theme?.colors?.input,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme?.spacing?.xs,
  },
  totalsItem: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  totalsLabel: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.textFine,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    fontSize: 9,
  },
  totalsValue: {
    ...(theme?.typography?.bodyBold ?? {}),
    fontSize: 13,
  },
  footer: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.textFine,
    textAlign: "center",
    marginTop: theme?.spacing?.s,
  },
  muted: {
    ...(theme?.typography?.body ?? {}),
    color: theme?.colors?.textSubtle,
    textAlign: "center",
  },
  errorTitle: {
    ...(theme?.typography?.bodyBold ?? {}),
    marginTop: 4,
  },
  doneTitle: {
    ...(theme?.typography?.bodyBold ?? {}),
    fontSize: 16,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.xs,
    borderRadius: 999,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.primary,
    marginTop: theme?.spacing?.xs,
  },
  retryText: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.primary,
    fontWeight: "700",
  },
});
