// Drop-down notification banner, pinned to the top of the screen above the
// router stack. Mounted once in app/_layout.jsx; driven entirely by the
// useBannerStore. Use `show()` or the `showBanner()` helper from anywhere
// to trigger.
//
// Visual:
//   - Slides down from above the status bar with a spring
//   - Left accent color + matching icon per kind (info/warning/error/success)
//   - Tap the card to dismiss, or tap the inline action button if present
//   - Auto-dismisses after the duration (default 4000ms; 0 to make sticky)

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { AnimatePresence, MotiView } from "moti";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBannerStore } from "../stores/useBannerStore";

const KIND_CONFIG = {
  info: {
    icon: "information-outline",
    accent: theme?.colors?.primary ?? "#5C5CE8",
  },
  warning: {
    icon: "alert-outline",
    accent: theme?.colors?.warning ?? "#D97706",
  },
  error: {
    icon: "alert-circle-outline",
    accent: theme?.colors?.error ?? "#DC2626",
  },
  success: {
    icon: "check-circle-outline",
    accent: theme?.colors?.success ?? "#16A34A",
  },
};

export default function TopBanner() {
  const visible = useBannerStore((s) => s.visible);
  const message = useBannerStore((s) => s.message);
  const kind = useBannerStore((s) => s.kind);
  const action = useBannerStore((s) => s.action);
  const hide = useBannerStore((s) => s.hide);
  const insets = useSafeAreaInsets();

  const config = KIND_CONFIG[kind] ?? KIND_CONFIG.info;
  // Inset + small breathing room so the banner doesn't kiss the status bar.
  const topOffset = (insets?.top ?? 0) + 8;

  function handleActionPress() {
    try {
      action?.onPress?.();
    } finally {
      hide();
    }
  }

  return (
    <View
      // Container is full-width but pointerEvents="box-none" so taps in the
      // empty space on either side of the card pass through to whatever is
      // beneath. Only the card itself absorbs touches.
      pointerEvents="box-none"
      style={[styles.container, { top: topOffset }]}
    >
      <AnimatePresence>
        {visible ? (
          <MotiView
            key="top-banner"
            from={{ opacity: 0, translateY: -80 }}
            animate={{ opacity: 1, translateY: 0 }}
            exit={{ opacity: 0, translateY: -80 }}
            transition={{
              type: "spring",
              damping: 18,
              stiffness: 220,
              mass: 0.7,
            }}
            style={styles.cardWrap}
          >
            <TouchableOpacity
              activeOpacity={0.92}
              onPress={hide}
              style={[styles.card, { borderLeftColor: config.accent }]}
            >
              <MaterialCommunityIcons
                name={config.icon}
                size={22}
                color={config.accent}
                style={styles.icon}
              />
              <Text style={styles.message} numberOfLines={3}>
                {message}
              </Text>
              {action?.label ? (
                <TouchableOpacity
                  onPress={handleActionPress}
                  hitSlop={theme?.layout?.hitSlop?.small}
                  style={[styles.actionBtn, { borderColor: config.accent }]}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.actionText, { color: config.accent }]}>
                    {action.label}
                  </Text>
                </TouchableOpacity>
              ) : (
                <MaterialCommunityIcons
                  name="close"
                  size={18}
                  color={theme?.colors?.textSubtle}
                  style={styles.closeIcon}
                />
              )}
            </TouchableOpacity>
          </MotiView>
        ) : null}
      </AnimatePresence>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    // High z-index so we sit above modal screens, FABs, etc.
    zIndex: 9999,
    elevation: 24,
    paddingHorizontal: theme?.spacing?.m ?? 14,
  },
  cardWrap: {
    width: "100%",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme?.colors?.cardBackground ?? "#FFFFFF",
    borderRadius: theme?.layout?.borderRadius?.m ?? 14,
    paddingVertical: theme?.spacing?.s ?? 8,
    paddingHorizontal: theme?.spacing?.m ?? 14,
    gap: theme?.spacing?.s ?? 8,
    borderLeftWidth: 4,
    // Stronger shadow than `medium` so it visibly floats above content.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
  },
  icon: {
    marginRight: 2,
  },
  message: {
    ...(theme?.typography?.body ?? {}),
    flex: 1,
    color: theme?.colors?.text,
  },
  closeIcon: {
    marginLeft: 2,
  },
  actionBtn: {
    paddingHorizontal: theme?.spacing?.s ?? 8,
    paddingVertical: 4,
    borderRadius: theme?.layout?.borderRadius?.s ?? 10,
    borderWidth: theme?.layout?.borderWidth?.base ?? 1,
  },
  actionText: {
    ...(theme?.typography?.caption ?? {}),
    fontWeight: "700",
  },
});
