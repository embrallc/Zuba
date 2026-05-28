// Month view.
//
// Layout (top → bottom):
//   - Calendar grid                    flex: 3
//   - Selected-day header + horizontal card carousel   flex: 2
//
// Tapping a day cell selects it locally — no more modal route. The bottom
// carousel reacts to `selectedDate` and animates new cards in.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Calendar } from "react-native-calendars";
import Animated, { FadeInDown, FadeInRight } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import InspectionTooltipCard from "../../components/InspectionTooltipCard";
import { useDebouncedPress } from "../../hooks/useDebouncedPress";
import { useInspectionStore } from "../../stores/useInspectionStore";
import { useMapStore } from "../../stores/useMapStore";

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
  return COMPLETE_FIELDS.every((f) => !!insp?.[f]);
}

function calcDotMargin(total) {
  if (total <= 1) return 0;
  const needed = total * DOT_SIZE;
  if (needed <= DOTS_AREA) return 2;
  return -((needed - DOTS_AREA) / (total - 1));
}

// ── Stable refs for DayCell → parent communication ─────────────────────────
// DayCell is at module level so the Calendar never unmounts/remounts it.
// Mutable refs let us pass the latest selected date + tap handler in without
// re-creating DayCell.
const onDayPressRef = { current: null };
const selectedDateRef = { current: TODAY };

// ── DayCell ────────────────────────────────────────────────────────────────
function DayCell({ date, state, marking }) {
  const inspections = marking?.inspections ?? [];
  const isToday = date?.dateString === TODAY;
  const isSelected = !isToday && date?.dateString === selectedDateRef.current;
  const isDisabled = state === "disabled";
  const ml = calcDotMargin(inspections.length);

  return (
    <TouchableOpacity
      onPress={() => onDayPressRef.current?.(date)}
      activeOpacity={0.6}
      style={dayCellStyles.cell}
    >
      <View
        style={[
          dayCellStyles.numWrap,
          isSelected && dayCellStyles.selectedCircle,
          isToday && dayCellStyles.todayCircle,
        ]}
      >
        <Text
          style={[
            dayCellStyles.num,
            isDisabled && dayCellStyles.numDisabled,
            isSelected && dayCellStyles.numSelected,
            isToday && dayCellStyles.numToday,
          ]}
        >
          {date?.day}
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
                backgroundColor: isComplete(insp)
                  ? theme?.colors?.success
                  : theme?.colors?.warning,
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
  todayCircle: { backgroundColor: theme?.colors?.primary },
  selectedCircle: {
    backgroundColor: theme?.colors?.primaryGhost ?? "rgba(92,92,232,0.10)",
    borderWidth: 1,
    borderColor: theme?.colors?.primary,
  },
  num: { fontSize: 13, color: theme?.colors?.text },
  numDisabled: { color: theme?.colors?.textFine },
  numSelected: { color: theme?.colors?.primary, fontWeight: "600" },
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
  calendarBackground: theme?.colors?.cardBackground,
  backgroundColor: theme?.colors?.cardBackground,
  textSectionTitleColor: "#888",
  monthTextColor: theme?.colors?.text,
  arrowColor: theme?.colors?.primary,
  textDisabledColor: theme?.colors?.textFine,
  dayTextColor: theme?.colors?.text,
  todayTextColor: theme?.colors?.primary,
  textDayFontSize: 13,
  textMonthFontSize: 15,
  textDayHeaderFontSize: 11,
};

// ── Main screen ────────────────────────────────────────────────────────────
export default function MonthViewScreen() {
  const router = useRouter();
  const inspections = useInspectionStore((s) => s.inspections);
  const sortedIds = useInspectionStore((s) => s.sortedIds);
  const openMapForInspection = useMapStore((s) => s.openForInspection);

  const screen = useWindowDimensions();
  // Card peeks the next one slightly so the carousel feels swipeable.
  const cardWidth = Math.round(screen.width * 0.82);
  const cardGap = theme?.spacing?.s ?? 8;
  const cardSidePadding = theme?.spacing?.m ?? 14;

  const [selectedDate, setSelectedDate] = useState(TODAY);
  selectedDateRef.current = selectedDate;

  // Group inspections by date → passed as marking to each DayCell, and used
  // again to derive the bottom carousel list.
  const inspectionsByDate = useMemo(() => {
    const result = {};
    sortedIds.forEach((id) => {
      const insp = inspections[id];
      if (!insp?.ScheduledAt) return;
      const dateStr = dayjs(insp.ScheduledAt).format("YYYY-MM-DD");
      if (!result[dateStr]) result[dateStr] = [];
      result[dateStr].push(insp);
    });
    return result;
  }, [inspections, sortedIds]);

  const markedDates = useMemo(() => {
    const out = {};
    for (const [date, list] of Object.entries(inspectionsByDate)) {
      out[date] = { inspections: list };
    }
    return out;
  }, [inspectionsByDate]);

  const dayInspections = inspectionsByDate[selectedDate] ?? [];

  onDayPressRef.current = useCallback((date) => {
    if (!date?.dateString) return;
    setSelectedDate(date.dateString);
  }, []);

  const handleOpenMap = useDebouncedPress(
    useCallback(
      (insp) => {
        if (!insp?.InspectionSk) return;
        openMapForInspection(insp.InspectionSk);
        router.push("/map");
      },
      [openMapForInspection, router],
    ),
  );

  const handleNavigate = useDebouncedPress(
    useCallback((insp) => {
      const addr = [insp?.AddressLine1, insp?.City, insp?.State, insp?.ZipCode]
        .filter(Boolean)
        .join(", ");
      if (!addr) return;
      const url =
        Platform.OS === "ios"
          ? `maps://?q=${encodeURIComponent(addr)}`
          : `geo:0,0?q=${encodeURIComponent(addr)}`;
      Linking.openURL(url).catch(() => {});
    }, []),
  );

  const handleEdit = useDebouncedPress(
    useCallback(
      (insp) => {
        if (!insp?.InspectionSk) return;
        router.push({
          pathname: "/addinspection",
          params: { inspectionSk: insp.InspectionSk },
        });
      },
      [router],
    ),
  );

  const dateLabel = useMemo(() => {
    if (!selectedDate) return "";
    const d = dayjs(selectedDate);
    if (selectedDate === TODAY) return `Today · ${d.format("MMM D")}`;
    return d.format("dddd, MMM D");
  }, [selectedDate]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Calendar — top 3/5 */}
      <View style={styles.calendarWrap}>
        <Calendar
          dayComponent={DayCell}
          markedDates={markedDates}
          theme={CALENDAR_THEME}
          enableSwipeMonths
          style={styles.calendar}
          // Make today / selected date click work even when the cell has no
          // dots: the cell still calls onDayPressRef on tap.
        />
      </View>

      {/* Header + horizontal carousel — bottom 2/5 */}
      <View style={styles.bottomSection}>
        <View style={styles.bottomHeader}>
          <MaterialCommunityIcons
            name="calendar-text"
            size={theme?.layout?.iconSize?.s ?? 16}
            color={theme?.colors?.textSubtle}
          />
          <Text style={styles.bottomTitle}>{dateLabel}</Text>
          <View style={styles.bottomCountBubble}>
            <Text style={styles.bottomCount}>{dayInspections.length}</Text>
          </View>
        </View>

        {dayInspections.length > 0 ? (
          <Animated.FlatList
            // Re-mount the list when the selected date changes so each card
            // plays the FadeInDown entrance animation fresh.
            key={selectedDate}
            data={dayInspections}
            keyExtractor={(item) => item.InspectionSk}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={cardWidth + cardGap}
            decelerationRate="fast"
            contentContainerStyle={[
              styles.carouselContent,
              { paddingHorizontal: cardSidePadding, gap: cardGap },
            ]}
            renderItem={({ item, index }) => (
              <Animated.View
                entering={FadeInDown.delay(Math.min(index * 60, 240))
                  .duration(380)
                  .springify()
                  .damping(15)}
                style={{ width: cardWidth }}
              >
                <InspectionTooltipCard
                  inspection={item}
                  onMap={handleOpenMap}
                  onNavigate={handleNavigate}
                  onEdit={handleEdit}
                />
              </Animated.View>
            )}
          />
        ) : (
          <Animated.View
            key={`empty-${selectedDate}`}
            entering={FadeInRight.duration(280)}
            style={styles.empty}
          >
            <MaterialCommunityIcons
              name="calendar-blank-outline"
              size={theme?.layout?.iconSize?.l ?? 28}
              color={theme?.colors?.textFine}
            />
            <Text style={styles.emptyText}>
              No inspections scheduled this day.
            </Text>
          </Animated.View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
  },
  calendarWrap: {
    flex: 3,
    overflow: "hidden",
    margin: theme?.spacing?.s,
    borderRadius: theme?.layout?.borderRadius?.m,
    backgroundColor: theme?.colors?.cardBackground,
    ...(theme?.shadows?.light ?? {}),
  },
  calendar: {
    borderRadius: theme?.layout?.borderRadius?.m,
    overflow: "hidden",
  },
  bottomSection: {
    flex: 2,
    // Transparent — cards visually float over the main background.
    backgroundColor: "transparent",
  },
  bottomHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.xs,
    paddingHorizontal: theme?.spacing?.m,
    paddingTop: theme?.spacing?.s,
    paddingBottom: theme?.spacing?.xs,
  },
  bottomTitle: {
    ...(theme?.typography?.label ?? {}),
    color: theme?.colors?.textSubtle,
    flex: 1,
  },
  bottomCountBubble: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: theme?.colors?.cardBackground,
    alignItems: "center",
    justifyContent: "center",
    ...(theme?.shadows?.light ?? {}),
  },
  bottomCount: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.primary,
    fontWeight: "700",
    textAlign: "center",
  },
  carouselContent: {
    // paddingBottom leaves room for the card shadow not to clip against the
    // tab bar / safe-area edge.
    paddingTop: theme?.spacing?.s,
    paddingBottom: theme?.spacing?.l ?? 24,
    alignItems: "stretch",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.s,
    paddingHorizontal: theme?.spacing?.xl,
  },
  emptyText: {
    ...(theme?.typography?.body ?? {}),
    color: theme?.colors?.textSubtle,
    textAlign: "center",
  },
});
