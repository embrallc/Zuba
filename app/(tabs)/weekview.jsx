import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  CalendarBody,
  CalendarContainer,
  CalendarHeader,
} from "@howljs/calendar-kit";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { updateInspection } from "../../db/inspections";
import { logError } from "../../db/logs";
import { useInspectionStore } from "../../stores/useInspectionStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { findOverlappingInspection } from "../../utils/overlapUtils";

const COMPLETE_FIELDS = [
  "FullName",
  "Phone",
  "Email",
  "AddressLine1",
  "City",
  "State",
  "ZipCode",
  "ScheduledAt",
  "Summary",
];

function isComplete(insp) {
  return COMPLETE_FIELDS.every((f) => !!insp[f]);
}

const CALENDAR_THEME = {
  colors: {
    primary: "#5C5CE8",
    onPrimary: "#fff",
    background: theme?.colors?.mainBackground ?? "#EDEEF8",
    onBackground: theme?.colors?.text ?? "#1E1B4B",
    border: theme?.colors?.input ?? "#E4E5F4",
    text: theme?.colors?.text ?? "#1E1B4B",
    surface: theme?.colors?.cardBackground ?? "#FFFFFF",
    onSurface: "#888",
  },
  hourTextStyle: { fontSize: 10, color: "#888" },
  headerBackgroundColor: theme?.colors?.cardBackground ?? "#FFFFFF",
  dayBarBorderColor: theme?.colors?.input ?? "#E4E5F4",
  dayName: { fontSize: 11, color: "#888", textTransform: "uppercase" },
  dayNumber: {
    fontSize: 13,
    fontWeight: "500",
    color: theme?.colors?.text ?? "#1E1B4B",
  },
  todayName: { fontSize: 11, color: "#5C5CE8", textTransform: "uppercase" },
  todayNumber: { fontSize: 13, fontWeight: "700", color: "#fff" },
  todayNumberContainer: { backgroundColor: "#5C5CE8", borderRadius: 99 },
  nowIndicatorColor: "#5C5CE8",
  eventContainerStyle: {
    borderRadius: theme?.layout?.borderRadius?.xs ?? 4,
    overflow: "hidden",
  },
};

const FAB_SIZE = theme?.layout?.iconSize?.l ? theme.layout.iconSize.l * 2 : 56;

export default function WeekViewScreen() {
  const router = useRouter();
  const calendarRef = useRef(null);

  const showWeekends = useSettingsStore((s) => s.showWeekends);
  const apptLengthMinutes = useSettingsStore((s) => s.apptLengthMinutes);
  const inspections = useInspectionStore((s) => s.inspections);
  const sortedIds = useInspectionStore((s) => s.sortedIds);
  const updateInStore = useInspectionStore((s) => s.update);
  const MIN_VIEW_HOUR = 5;
  const MAX_VIEW_HOUR = 21;
  const now = new Date();
  const currentHour = now.getHours();

  // Visible date tracked for the week label
  const [currentDate, setCurrentDate] = useState(() =>
    dayjs().format("YYYY-MM-DD"),
  );

  // ── Events ────────────────────────────────────────────────────────────────

  const events = useMemo(
    () =>
      sortedIds
        .map((id) => inspections[id])
        .filter((insp) => insp?.ScheduledAt)
        .map((insp) => ({
          id: insp.InspectionSk,
          start: { dateTime: insp.ScheduledAt },
          end: {
            dateTime: dayjs(insp.ScheduledAt)
              .add(apptLengthMinutes, "minute")
              .toISOString(),
          },
          // Extra fields available in renderEvent and onDragEventEnd
          fullName: insp.FullName || "Inspection",
          complete: isComplete(insp),
        })),
    [inspections, sortedIds, apptLengthMinutes],
  );

  const apptLen = apptLengthMinutes < 60 ? 120 : 60;

  const displayHour = Math.min(
    Math.max(currentHour - 2, MIN_VIEW_HOUR),
    MAX_VIEW_HOUR,
  );

  const monthLabel = useMemo(
    () => dayjs(currentDate).format("MMMM YYYY"),
    [currentDate],
  );

  const handleDateChanged = useCallback((date) => {
    setCurrentDate(date);
  }, []);

  // ── Interaction ────────────────────────────────────────────────────────────
  const handlePressBackground = useCallback(
    ({ dateTime, date }) => {
      const iso = dateTime ?? (date ? `${date}T09:00:00.000Z` : null);
      if (!iso) return;
      try {
        router.push({
          pathname: "/addinspection",
          params: { prefilledAt: iso },
        });
      } catch (e) {
        logError(e, "WeekView.handlePressBackground");
      }
    },
    [router],
  );

  const handlePressEvent = useCallback(
    (event) => {
      try {
        router.push({
          pathname: "/addinspection",
          params: { inspectionSk: event.id },
        });
      } catch (e) {
        logError(e, "WeekView.handlePressEvent");
      }
    },
    [router],
  );

  const handleDragEventEnd = useCallback(
    async (event) => {
      try {
        const newScheduledAt = event.start.dateTime;
        const insp = inspections[event.id];
        if (!insp) return;

        const overlap = findOverlappingInspection(
          newScheduledAt,
          apptLengthMinutes,
          inspections,
          event.id,
        );
        if (overlap) {
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          ).catch(() => {});
          // Not updating store — library reverts to original position
          return;
        }

        const updated = await updateInspection(event.id, {
          ...insp,
          ScheduledAt: newScheduledAt,
        });
        updateInStore({ ...insp, ...updated });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      } catch (e) {
        logError(e, `WeekView.handleDragEventEnd id=${event.id}`);
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Error,
        ).catch(() => {});
      }
    },
    [inspections, apptLengthMinutes, updateInStore],
  );

  // ── Custom event card ──────────────────────────────────────────────────────
  const renderEvent = useCallback((event) => {
    return (
      <View style={styles.eventCard}>
        <View
          style={[
            styles.eventSidebar,
            { backgroundColor: event.complete ? theme.colors.success : theme.colors.warning },
          ]}
        />
        <View style={styles.eventBody}>
          <Text style={styles.eventName} numberOfLines={1}>
            {event.fullName}
          </Text>
          <Text style={styles.eventTime}>
            {dayjs(event.start.dateTime).format("h:mm A")}
          </Text>
        </View>
      </View>
    );
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Text style={styles.monthLabel}>{monthLabel}</Text>

      <CalendarContainer
        key={apptLen}
        ref={calendarRef}
        numberOfDays={7}
        hideWeekDays={showWeekends ? [] : [6, 7]}
        scrollByDay={false}
        firstDay={1}
        events={events}
        theme={CALENDAR_THEME}
        initialTimeIntervalHeight={apptLen}
        timeInterval={60}
        minTime={{ hour: MIN_VIEW_HOUR, minute: 0 }}
        maxTime={{ hour: MAX_VIEW_HOUR, minute: 0 }}
        initialTime={{ hour: displayHour, minute: 0 }}
        dragStep={30}
        useHaptic
        allowDragToEdit
        useAllDayEvent={false}
        spaceFromTop={0}
        onDateChanged={handleDateChanged}
        onPressBackground={handlePressBackground}
        onPressEvent={handlePressEvent}
        onDragEventEnd={handleDragEventEnd}
      >
        <CalendarHeader />
        <CalendarBody renderEvent={renderEvent} />
      </CalendarContainer>

      <TouchableOpacity
        style={styles.fab}
        activeOpacity={0.85}
        onPress={() => {
          const h = new Date().getHours();
          const scrollHour = Math.min(
            Math.max(h - 2, MIN_VIEW_HOUR),
            MAX_VIEW_HOUR,
          );
          calendarRef.current?.goToDate({
            date: dayjs()
              .hour(scrollHour)
              .minute(0)
              .second(0)
              .format("YYYY-MM-DDTHH:mm:ss"),
            animatedDate: true,
            hourScroll: true,
            animatedHour: true,
          });
        }}
      >
        <MaterialCommunityIcons
          name="calendar-today"
          size={FAB_SIZE * 0.45}
          color="#fff"
        />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground ?? "#e1e4e4",
  },
  monthLabel: {
    textAlign: "center",
    paddingVertical: theme?.spacing?.xs ?? 4,
    fontSize: 13,
    fontWeight: "500",
    color: theme?.colors?.secondaryText ?? "#888",
    backgroundColor: theme?.colors?.cardBackground ?? "#fcffff",
    borderBottomWidth: theme?.layout?.borderWidth?.thin ?? 0.5,
    borderBottomColor: theme?.colors?.input ?? "#dddfdf",
  },

  fab: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: theme?.colors?.primary ?? "#5C5CE8",
    alignItems: "center",
    justifyContent: "center",
    ...(theme?.shadows?.medium ?? {}),
  },

  eventCard: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme?.colors?.cardBackground ?? "#fcffff",
  },
  eventSidebar: { width: 4 },
  eventBody: {
    flex: 1,
    paddingHorizontal: theme?.spacing?.xs ?? 4,
    paddingVertical: 3,
    justifyContent: "center",
  },
  eventName: {
    fontSize: 11,
    fontWeight: "600",
    color: theme?.colors?.text ?? "#2a2b2b",
  },
  eventTime: {
    fontSize: 10,
    color: "#888",
  },
});
