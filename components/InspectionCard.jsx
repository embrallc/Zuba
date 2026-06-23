import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from "react-native";
import { TouchableOpacity as GestureTouchableOpacity } from "react-native-gesture-handler";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { setInspectionStatus, softDeleteInspection } from "../db/inspections";
import { logError } from "../db/logs";
import { useDebouncedPress } from "../hooks/useDebouncedPress";
import { useBannerStore } from "../stores/useBannerStore";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useMapStore } from "../stores/useMapStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useSmsStore } from "../stores/useSmsStore";
import { reconcileInspection } from "../utils/autoComms";
import { generateInspectionReport } from "../utils/reports";
import { pushInspection, pushInspectionForm } from "../utils/sync";
import RequestPaymentSheet from "./RequestPaymentSheet";

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

function isComplete(inspection) {
  return COMPLETE_FIELDS.every((f) => !!inspection[f]);
}

function formatAddress(inspection) {
  const parts = [
    inspection.AddressLine1,
    inspection.AddressLine2,
    inspection.City,
    inspection.State,
    inspection.ZipCode,
  ];
  return parts.filter(Boolean).join(", ");
}

async function openCall(phone) {
  if (!phone) {
    Alert.alert("No phone number on this inspection.");
    return;
  }
  await Linking.openURL(`tel:${phone}`);
}

async function openEmail(email) {
  if (!email) {
    Alert.alert("No email address on this inspection.");
    return;
  }
  await Linking.openURL(`mailto:${email}`);
}

async function openNavigation(inspection) {
  if (!inspection.AddressLine1) {
    Alert.alert("No address on this inspection.");
    return;
  }
  const addr = formatAddress(inspection);
  const encoded = encodeURIComponent(addr);
  const url =
    Platform.OS === "ios" ? `maps:?daddr=${encoded}` : `geo:0,0?q=${encoded}`;
  await Linking.openURL(url);
}

// ─── SMS Bubble ───────────────────────────────────────────────────────────────

const TAIL_SIZE = 13;
const BUBBLE_MAX_WIDTH = 268;
const TAIL_FROM_LEFT = 22;

function SmsBubble({ anchor, templates, onClose }) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 210,
      easing: Easing.out(Easing.cubic),
    });
  }, []);

  function handleClose() {
    progress.value = withTiming(0, { duration: 130 }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }

  const bubbleAnim = useAnimatedStyle(() => {
    const s = progress.value;
    return {
      opacity: s,
      transform: [
        { scale: interpolate(s, [0, 1], [0.12, 1]) },
        { translateY: interpolate(s, [0, 1], [16, 0]) },
      ],
    };
  });

  // Position bubble above the tapped button
  const buttonCenterX = anchor.x + anchor.w / 2;
  const bubbleLeft = Math.max(
    8,
    Math.min(
      buttonCenterX - TAIL_FROM_LEFT - TAIL_SIZE,
      windowWidth - BUBBLE_MAX_WIDTH - 8,
    ),
  );
  // bottom of bubble sits just above the button with a gap for the tail
  const bubbleBottom = windowHeight - anchor.y + TAIL_SIZE + 2;

  // Where the tail triangle sits within the bubble
  const tailLeft = Math.max(10, buttonCenterX - bubbleLeft - TAIL_SIZE);

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop */}
        <TouchableWithoutFeedback onPress={handleClose}>
          <View style={[StyleSheet.absoluteFill, bubbleStyles.backdrop]} />
        </TouchableWithoutFeedback>

        {/* Bubble */}
        <Animated.View
          style={[
            bubbleStyles.bubble,
            { bottom: bubbleBottom, left: bubbleLeft },
            bubbleAnim,
          ]}
        >
          {templates.length === 0 ? (
            <View style={bubbleStyles.empty}>
              <MaterialCommunityIcons
                name="message-text-outline"
                size={20}
                color={theme.colors.textFine}
              />
              <Text style={bubbleStyles.emptyText}>
                No templates yet.{"\n"}Add some in Settings → Messaging.
              </Text>
            </View>
          ) : (
            <View style={bubbleStyles.pillsRow}>
              {templates.map((t) => (
                <TouchableOpacity
                  key={t.SmsTemplateSk}
                  style={bubbleStyles.pill}
                  activeOpacity={0.7}
                >
                  <Text style={bubbleStyles.pillText} numberOfLines={1}>
                    {t.Name || "Unnamed"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Tail triangle */}
          <View style={[bubbleStyles.tail, { left: tailLeft }]} />
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─── InspectionCard ───────────────────────────────────────────────────────────

export default function InspectionCard({ inspection, onPress }) {
  const openForInspection = useMapStore((s) => s.openForInspection);
  const router = useRouter();
  const templates = useSmsStore((s) => s.templates);

  const scale = useSharedValue(1);
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const [smsOpen, setSmsOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const smsRef = useRef(null);
  const swipeRef = useRef(null);
  const removeFromStore = useInspectionStore((s) => s.remove);
  const showBanner = useBannerStore((s) => s.show);
  const userProfile = useSettingsStore((s) => s.userProfile);

  const complete = isComplete(inspection);
  const address = formatAddress(inspection);
  const scheduledDate = inspection.ScheduledAt
    ? dayjs(inspection.ScheduledAt).format("MMM D, YYYY")
    : "—";
  const scheduledTime = inspection.ScheduledAt
    ? dayjs(inspection.ScheduledAt).format("h:mm A")
    : "";

  const handleSmsPress = useDebouncedPress(() => {
    if (!inspection.Phone) {
      Alert.alert("No phone number on this inspection.");
      return;
    }
    smsRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, w, h });
      setSmsOpen(true);
    });
  });

  const handleCall = useDebouncedPress(async () => {
    try {
      await openCall(inspection.Phone);
    } catch (e) {
      logError(e, `InspectionCard.handleCall sk=${inspection.InspectionSk}`);
    }
  });

  const handleEmail = useDebouncedPress(async () => {
    try {
      await openEmail(inspection.Email);
    } catch (e) {
      logError(e, `InspectionCard.handleEmail sk=${inspection.InspectionSk}`);
    }
  });

  const handleNavigation = useDebouncedPress(async () => {
    try {
      await openNavigation(inspection);
    } catch (e) {
      logError(
        e,
        `InspectionCard.handleNavigation sk=${inspection.InspectionSk}`,
      );
    }
  });

  const handleMapPin = useDebouncedPress(() => {
    try {
      openForInspection(inspection.InspectionSk);
      router.push("/map");
    } catch (e) {
      logError(e, `InspectionCard.handleMapPin sk=${inspection.InspectionSk}`);
    }
  });

  const handleOpenForm = useDebouncedPress(() => {
    try {
      router.push({
        pathname: "/inspectionform",
        params: { inspectionSk: inspection.InspectionSk },
      });
    } catch (e) {
      logError(
        e,
        `InspectionCard.handleOpenForm sk=${inspection.InspectionSk}`,
      );
    }
  });

  const clientLabel = inspection.FullName || "Inspection";

  // Mark complete: flip Status → CLOSED. setInspectionStatus emits an event
  // that cancels the reminder; removing from the store drops it out of every
  // list/calendar view immediately. Restorable from Settings → Completed.
  const handleComplete = useDebouncedPress(async () => {
    swipeRef.current?.close();
    try {
      await setInspectionStatus(inspection.InspectionSk, "CLOSED");
      removeFromStore(inspection.InspectionSk);
      showBanner({
        message: `${clientLabel} marked complete.`,
        kind: "success",
      });
      // Push the CLOSED status AND the walkthrough answers (so the server has
      // fresh form data to render), THEN nudge the reconciler so it snapshots
      // the org policy and auto-sends/holds the report. The form push must land
      // before the reconcile, or generate-report renders from stale cloud
      // answers (header only, blank sections). Fire-and-forget — the cron sweep
      // backstops if the device is offline or this is interrupted.
      Promise.all([
        pushInspection(inspection.InspectionSk),
        pushInspectionForm(inspection.InspectionSk),
      ])
        .then(() => reconcileInspection(inspection.InspectionSk))
        .catch(() => {});
    } catch (e) {
      logError(
        e,
        `InspectionCard.handleComplete sk=${inspection.InspectionSk}`,
      );
      showBanner({
        message: "Couldn't complete that inspection.",
        kind: "error",
      });
    }
  });

  // Delete: confirm, then soft-delete (_deleted = 1). Restorable from
  // Settings → Deleted.
  const handleDelete = useDebouncedPress(() => {
    swipeRef.current?.close();
    Alert.alert(
      "Delete Inspection",
      `Delete the inspection for ${clientLabel}? You can restore it later from Settings.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await softDeleteInspection(inspection.InspectionSk);
              removeFromStore(inspection.InspectionSk);
              showBanner({ message: `${clientLabel} deleted.`, kind: "info" });
            } catch (e) {
              logError(
                e,
                `InspectionCard.handleDelete sk=${inspection.InspectionSk}`,
              );
              showBanner({
                message: "Couldn't delete that inspection.",
                kind: "error",
              });
            }
          },
        },
      ],
    );
  });

  // Generate the report PDF. The swipe row stays open so the spinner inside
  // the button doubles as the progress indicator; sync + server render +
  // download can take several seconds.
  const handleGenerateReport = useDebouncedPress(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await generateInspectionReport(inspection);
      swipeRef.current?.close();
      showBanner({
        message:
          `Report ready for ${clientLabel}` +
          (result.pageCount ? ` — ${result.pageCount} page${result.pageCount === 1 ? "" : "s"}.` : ".") +
          (result.usedDraft ? " (Using unpublished draft template.)" : ""),
        kind: "success",
        duration: 6000,
        action: {
          label: "View",
          onPress: () =>
            router.push({
              pathname: "/reportviewer",
              params: { inspectionSk: inspection.InspectionSk },
            }),
        },
      });
    } catch (e) {
      logError(e, `InspectionCard.handleGenerateReport sk=${inspection.InspectionSk}`);
      showBanner({
        message: e?.presentable ? e.message : "Couldn't generate the report.",
        kind: "error",
        duration: 6000,
      });
    } finally {
      setGenerating(false);
    }
  });

  const handleOpenReport = useDebouncedPress(() => {
    swipeRef.current?.close();
    try {
      router.push({
        pathname: "/reportviewer",
        params: { inspectionSk: inspection.InspectionSk },
      });
    } catch (e) {
      logError(e, `InspectionCard.handleOpenReport sk=${inspection.InspectionSk}`);
    }
  });

  // Request payment: open the reusable amount/link sheet.
  const handleRequestPaymentPress = useDebouncedPress(() => {
    swipeRef.current?.close();
    setPayOpen(true);
  });

  function renderRightActions() {
    return (
      <View style={styles.rightActions}>
        <GestureTouchableOpacity
          onPress={handleComplete}
          activeOpacity={0.8}
          style={[styles.actionCircle, styles.completeCircle]}
        >
          <MaterialCommunityIcons name="check-bold" size={22} color="#fff" />
        </GestureTouchableOpacity>
        <GestureTouchableOpacity
          onPress={handleDelete}
          activeOpacity={0.8}
          style={[styles.actionCircle, styles.deleteCircle]}
        >
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={22}
            color="#fff"
          />
        </GestureTouchableOpacity>
        <GestureTouchableOpacity
          onPress={handleGenerateReport}
          activeOpacity={0.8}
          disabled={generating}
          style={[styles.actionCircle, styles.reportCircle]}
        >
          {generating ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialCommunityIcons name="printer-outline" size={22} color="#fff" />
          )}
        </GestureTouchableOpacity>
        {!!inspection.LastReportPath && (
          <GestureTouchableOpacity
            onPress={handleOpenReport}
            activeOpacity={0.8}
            style={[styles.actionCircle, styles.shareCircle]}
          >
            <MaterialCommunityIcons name="share-variant" size={20} color="#fff" />
          </GestureTouchableOpacity>
        )}
        <GestureTouchableOpacity
          onPress={handleRequestPaymentPress}
          activeOpacity={0.8}
          style={[styles.actionCircle, styles.payCircle]}
        >
          <MaterialCommunityIcons name="currency-usd" size={22} color="#fff" />
        </GestureTouchableOpacity>
      </View>
    );
  }

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      friction={2}
      containerStyle={styles.swipeContainer}
    >
      <Animated.View style={cardStyle}>
        <TouchableOpacity
          onPress={onPress}
          onPressIn={() => {
            scale.value = withSpring(0.97, { damping: 14, stiffness: 220 });
          }}
          onPressOut={() => {
            scale.value = withSpring(1, { damping: 14, stiffness: 220 });
          }}
          activeOpacity={1}
          style={styles.container}
        >
          <View
            style={[
              styles.sidebar,
              {
                backgroundColor: complete
                  ? theme.colors.success
                  : theme.colors.warning,
              },
            ]}
          />

          <View style={styles.body}>
            <View style={styles.headerRow}>
              <Text style={styles.name} numberOfLines={1}>
                {inspection.FullName || "Unnamed Inspection"}
              </Text>
              <Text style={styles.datetime}>
                {scheduledDate}
                {scheduledTime ? `  ${scheduledTime}` : ""}
              </Text>
            </View>

            {address ? (
              <Text style={styles.address} numberOfLines={1}>
                {address}
              </Text>
            ) : (
              <Text style={styles.addressEmpty}>No address entered</Text>
            )}

            <View style={styles.actions}>
              {!!inspection.Phone && (
                <TouchableOpacity
                  ref={smsRef}
                  onPress={handleSmsPress}
                  hitSlop={theme.layout.hitSlop.medium}
                  style={styles.actionBtn}
                >
                  <MaterialCommunityIcons
                    name="message-text-outline"
                    size={theme.layout.iconSize.m}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              )}

              {!!inspection.Phone && (
                <TouchableOpacity
                  onPress={handleCall}
                  hitSlop={theme.layout.hitSlop.medium}
                  style={styles.actionBtn}
                >
                  <MaterialCommunityIcons
                    name="phone-outline"
                    size={theme.layout.iconSize.m}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              )}

              {!!inspection.Email && (
                <TouchableOpacity
                  onPress={handleEmail}
                  hitSlop={theme.layout.hitSlop.medium}
                  style={styles.actionBtn}
                >
                  <MaterialCommunityIcons
                    name="email-outline"
                    size={theme.layout.iconSize.m}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              )}

              {!!inspection.AddressLine1 && (
                <TouchableOpacity
                  onPress={handleNavigation}
                  hitSlop={theme.layout.hitSlop.medium}
                  style={styles.actionBtn}
                >
                  <MaterialCommunityIcons
                    name="navigation-outline"
                    size={theme.layout.iconSize.m}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              )}

              {!!(inspection.Latitude && inspection.Longitude) && (
                <TouchableOpacity
                  onPress={handleMapPin}
                  hitSlop={theme.layout.hitSlop.medium}
                  style={styles.actionBtn}
                >
                  <MaterialCommunityIcons
                    name="map-marker-outline"
                    size={theme.layout.iconSize.m}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={handleOpenForm}
                hitSlop={theme.layout.hitSlop.medium}
                style={[styles.actionBtn, styles.formBtn]}
              >
                <MaterialCommunityIcons
                  name="clipboard-text-outline"
                  size={theme.layout.iconSize.m}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            </View>
          </View>

          {inspection.PaymentState && inspection.PaymentState !== "none" ? (
            <View style={styles.ribbonWrap} pointerEvents="none">
              <View
                style={[
                  styles.ribbon,
                  inspection.Paid ? styles.ribbonPaid : styles.ribbonBilled,
                ]}
              >
                <Text style={styles.ribbonText}>
                  {inspection.Paid ? "PAID" : "BILLED"}
                </Text>
              </View>
            </View>
          ) : null}
        </TouchableOpacity>

        {smsOpen && anchor && (
          <SmsBubble
            anchor={anchor}
            templates={templates}
            onClose={() => setSmsOpen(false)}
          />
        )}

        <RequestPaymentSheet
          visible={payOpen}
          onClose={() => setPayOpen(false)}
          inspectionSk={inspection.InspectionSk}
          clientName={inspection.FullName}
          userProfile={userProfile}
          onSuccess={() =>
            showBanner({
              message: `Payment link ready for ${clientLabel}.`,
              kind: "success",
            })
          }
        />
      </Animated.View>
    </ReanimatedSwipeable>
  );
}

const bubbleStyles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  bubble: {
    position: "absolute",
    maxWidth: BUBBLE_MAX_WIDTH,
    minWidth: 160,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.m,
    paddingBottom: theme.spacing.s,
    ...theme.shadows.medium,
    // ensure shadow renders above backdrop
    elevation: 8,
  },
  tail: {
    position: "absolute",
    bottom: -TAIL_SIZE,
    width: 0,
    height: 0,
    borderLeftWidth: TAIL_SIZE,
    borderRightWidth: TAIL_SIZE,
    borderTopWidth: TAIL_SIZE,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: theme.colors.cardBackground,
  },
  pillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.s,
    paddingBottom: theme.spacing.xs,
  },
  pill: {
    backgroundColor: theme.colors.primaryGhost,
    borderRadius: theme.layout.borderRadius.full,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: 6,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: "rgba(92,92,232,0.18)",
  },
  pillText: {
    ...theme.typography.label,
    color: theme.colors.primary,
    fontWeight: "600",
  },
  empty: {
    alignItems: "center",
    gap: theme.spacing.s,
    paddingVertical: theme.spacing.s,
    paddingBottom: theme.spacing.m,
  },
  emptyText: {
    ...theme.typography.label,
    color: theme.colors.textFine,
    textAlign: "center",
    lineHeight: 18,
  },
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    marginHorizontal: theme.spacing.s,
    marginBottom: theme.spacing.s,
    overflow: "hidden",
    ...theme.shadows.light,
  },
  sidebar: {
    width: 5,
  },
  body: {
    flex: 1,
    padding: theme.spacing.m,
    gap: theme.spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing.s,
  },
  name: {
    ...theme.typography.h4,
    flex: 1,
  },
  datetime: {
    ...theme.typography.h4,
    flexShrink: 0,
  },
  address: {
    ...theme.typography.label,
  },
  addressEmpty: {
    ...theme.typography.caption,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing.m,
    marginTop: theme.spacing.xs,
  },
  actionBtn: {
    padding: theme.spacing.xs,
  },
  formBtn: {
    marginLeft: "auto",
  },
  // Don't clip the revealed swipe actions / their shadows.
  swipeContainer: {
    overflow: "visible",
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.s,
    paddingHorizontal: theme?.spacing?.m,
    // Match the card's own marginBottom so the circles line up with the
    // card body rather than the inter-card gap.
    marginBottom: theme?.spacing?.s,
  },
  actionCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    ...theme?.shadows?.light,
  },
  completeCircle: {
    backgroundColor: theme?.colors?.success,
  },
  deleteCircle: {
    backgroundColor: theme?.colors?.error,
  },
  reportCircle: {
    backgroundColor: theme?.colors?.primary,
  },
  shareCircle: {
    backgroundColor: theme?.colors?.icon,
  },
  payCircle: {
    backgroundColor: theme?.colors?.warning,
  },
  // ─── Payment status corner ribbon ───
  // The card container clips overflow, so a 45° band pinned to the top-right
  // reads as a folded corner ribbon. pointerEvents none so it never eats taps.
  ribbonWrap: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 82,
    height: 82,
    overflow: "hidden",
  },
  ribbon: {
    position: "absolute",
    top: 13,
    right: -26,
    width: 110,
    paddingVertical: 3,
    alignItems: "center",
    transform: [{ rotate: "45deg" }],
    ...theme?.shadows?.light,
  },
  ribbonBilled: { backgroundColor: theme?.colors?.warning },
  ribbonPaid: { backgroundColor: theme?.colors?.success },
  ribbonText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
});
