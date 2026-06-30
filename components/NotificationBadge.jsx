import { theme } from "@theme";
import { MotiView } from "moti";
import { StyleSheet, Text } from "react-native";

// Small red numeric badge for unread counts (e.g. cancellations). Renders
// nothing when count <= 0. Bounces a little "bubbly" attention pulse on mount
// and every time `pulse` changes — the parent bumps `pulse` on app-enter and on
// entering Settings. Position it via the `style` prop (the parent makes it
// absolute over an icon/row).
export default function NotificationBadge({ count = 0, pulse = 0, style }) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  const label = n > 99 ? "99+" : String(n);

  return (
    <MotiView
      // Remounting on each pulse replays the keyframe bounce from the start.
      key={pulse}
      from={{ scale: 0.85 }}
      animate={{ scale: [0.85, 1.28, 0.95, 1] }}
      transition={{ scale: { type: "timing", duration: 460 } }}
      style={[styles.badge, n > 9 && styles.badgeWide, style]}
      pointerEvents="none"
    >
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: theme?.colors?.error ?? "#DC2626",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: theme?.colors?.cardBackground ?? "#FFFFFF",
  },
  badgeWide: {
    paddingHorizontal: 5,
  },
  text: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 13,
    textAlign: "center",
  },
});
