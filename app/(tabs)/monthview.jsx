import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Calendar } from "react-native-calendars";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInspectionStore } from "../../stores/useInspectionStore";
import { useUIStore } from "../../stores/useUIStore";

// ── Constants ──────────────────────────────────────────────────────────────
const DOT_SIZE = 16;
const DOT_FONT = 6;
const DOTS_AREA = 40;
const TODAY = dayjs().format("YYYY-MM-DD");

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

// ── Helpers ────────────────────────────────────────────────────────────────
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isComplete(insp) {
  return COMPLETE_FIELDS.every((f) => !!insp[f]);
}

function calcDotMargin(total) {
  if (total <= 1) return 0;
  const needed = total * DOT_SIZE;
  if (needed <= DOTS_AREA) return 2;
  return -((needed - DOTS_AREA) / (total - 1));
}

// ── Stable ref for DayCell → parent callback ───────────────────────────────
// DayCell is at module level so the Calendar never unmounts/remounts it.
const onDayPressRef = { current: null };

// ── DayCell ────────────────────────────────────────────────────────────────
function DayCell({ date, state, marking }) {
  const inspections = marking?.inspections ?? [];
  const isToday = date.dateString === TODAY;
  const isDisabled = state === "disabled";
  const ml = calcDotMargin(inspections.length);

  return (
    <TouchableOpacity
      onPress={() => onDayPressRef.current?.(date, inspections)}
      activeOpacity={inspections.length ? 0.65 : 1}
      style={dayCellStyles.cell}
    >
      <View
        style={[dayCellStyles.numWrap, isToday && dayCellStyles.todayCircle]}
      >
        <Text
          style={[
            dayCellStyles.num,
            isDisabled && dayCellStyles.numDisabled,
            isToday && dayCellStyles.numToday,
          ]}
        >
          {date.day}
        </Text>
      </View>

      <View style={dayCellStyles.dotsRow}>
        {inspections.map((insp, i) => (
          <View
            key={insp.InspectionSk}
            style={[
              dayCellStyles.dot,
              {
                marginLeft: i === 0 ? 0 : ml,
                backgroundColor: isComplete(insp) ? theme.colors.success : theme.colors.warning,
              },
            ]}
          >
            <Text style={dayCellStyles.dotText}>
              {getInitials(insp.FullName)}
            </Text>
          </View>
        ))}
      </View>
    </TouchableOpacity>
  );
}

const dayCellStyles = StyleSheet.create({
  cell: {
    alignItems: "center",
    paddingVertical: 4,
    width: "100%",
    minHeight: 52,
  },
  numWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  todayCircle: { backgroundColor: theme.colors.primary },
  num: { fontSize: 13, color: theme.colors.text },
  numDisabled: { color: theme.colors.textFine },
  numToday: { color: "#fff", fontWeight: "700" },
  dotsRow: {
    flexDirection: "row",
    marginTop: 3,
    alignItems: "center",
    width: DOTS_AREA,
    justifyContent: "flex-start",
    overflow: "visible",
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dotText: {
    fontSize: DOT_FONT,
    color: "#fff",
    fontWeight: "700",
    letterSpacing: -0.3,
  },
});

// ── Calendar library theme ─────────────────────────────────────────────────
const CALENDAR_THEME = {
  calendarBackground: theme.colors.cardBackground,
  backgroundColor: theme.colors.cardBackground,
  textSectionTitleColor: "#888",
  monthTextColor: theme.colors.text,
  arrowColor: theme.colors.primary,
  textDisabledColor: theme.colors.textFine,
  dayTextColor: theme.colors.text,
  todayTextColor: theme.colors.primary,
  textDayFontSize: 13,
  textMonthFontSize: 15,
  textDayHeaderFontSize: 11,
};

// ── Main screen ────────────────────────────────────────────────────────────
export default function MonthViewScreen() {
  const router = useRouter();
  const setSelectedDate = useUIStore((s) => s.setSelectedDate);
  const inspections = useInspectionStore((s) => s.inspections);
  const sortedIds = useInspectionStore((s) => s.sortedIds);

  // Group inspections by date → passed as marking to each DayCell
  const markedDates = useMemo(() => {
    const result = {};
    sortedIds.forEach((id) => {
      const insp = inspections[id];
      if (!insp?.ScheduledAt) return;
      const dateStr = dayjs(insp.ScheduledAt).format("YYYY-MM-DD");
      if (!result[dateStr]) result[dateStr] = { inspections: [] };
      result[dateStr].inspections.push(insp);
    });
    return result;
  }, [inspections, sortedIds]);

  onDayPressRef.current = useCallback(
    (date, dayInspections) => {
      if (!dayInspections.length) return;
      setSelectedDate(date.dateString);
      router.push("/monthtooltip");
    },
    [setSelectedDate, router],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Calendar
        dayComponent={DayCell}
        markedDates={markedDates}
        theme={CALENDAR_THEME}
        enableSwipeMonths
        style={styles.calendar}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
  },
  calendar: {
    borderRadius: theme.layout.borderRadius.m,
    overflow: "hidden",
    margin: theme.spacing.s,
    ...theme.shadows.light,
  },
});
