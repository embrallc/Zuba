import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { AnimatePresence, MotiView } from "moti";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

// A slim per-section "toolbelt": a collapsed chevron handle pinned to the right
// edge of a walkthrough card. Tapping it rolls out a small floating column of
// tool icons that overlays the card (so a one-field section still shows the
// full list without pushing other UI around), then collapses away.
//
// Prototype scope: one tool (Scanner). Extensible by design — pass more entries
// in `tools` and they appear as more icons. `onSelect(toolId)` fires when a tool
// is tapped (the host owns what the tool does). `topOffset` nudges the handle
// down so it clears a card header (e.g. a repeatable instance's delete button).
//
// Transitions use Moti timing (not spring) so the reveal is smooth, not bouncy.

const DEFAULT_TOOLS = [
  { id: "scanner", icon: "barcode-scan", label: "Scan" },
];

export default function SectionToolbelt({ tools = DEFAULT_TOOLS, onSelect }) {
  const [open, setOpen] = useState(false);

  const pick = (id) => {
    setOpen(false);
    onSelect?.(id);
  };

  return (
    // box-none so the card's fields stay tappable when the belt is closed —
    // only the handle (and the backdrop, while open) receive touches.
    <View style={s.wrap} pointerEvents="box-none">
      <AnimatePresence>
        {open && (
          <MotiView
            key="backdrop"
            from={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "timing", duration: 140 }}
            style={s.backdrop}
          >
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setOpen(false)}
              accessibilityLabel="Close section tools"
            />
          </MotiView>
        )}
      </AnimatePresence>

      {/* Handle — a slim tab hanging from the section's top border */}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        hitSlop={theme?.layout?.hitSlop?.medium}
        style={s.handle}
        accessibilityLabel="Section tools"
        accessibilityRole="button"
      >
        <MaterialCommunityIcons
          name={open ? "chevron-up" : "chevron-down"}
          size={14}
          color={theme?.colors?.primary}
        />
      </Pressable>

      {/* Rolled-out tool column */}
      <AnimatePresence>
        {open && (
          <MotiView
            key="tools"
            from={{ opacity: 0, translateY: -8, scale: 0.96 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            exit={{ opacity: 0, translateY: -8, scale: 0.96 }}
            transition={{ type: "timing", duration: 180 }}
            style={s.column}
          >
            {tools.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => pick(t.id)}
                style={({ pressed }) => [s.toolBtn, pressed && s.toolBtnPressed]}
                accessibilityLabel={t.label}
                accessibilityRole="button"
              >
                <MaterialCommunityIcons
                  name={t.icon}
                  size={22}
                  color={theme?.colors?.primary}
                />
                <Text style={s.toolLabel} numberOfLines={1}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </MotiView>
        )}
      </AnimatePresence>
    </View>
  );
}

const s = StyleSheet.create({
  // Overlays the whole card; children position against it. High z so the belt
  // (and its backdrop) float above the card's field content.
  wrap: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    elevation: 40,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  handle: {
    // Hangs from the section's top border, ~25% in from the right so it clears
    // the repeatable card's delete button. Slim + rounded only on the bottom so
    // it reads as part of the border, not a floating button.
    position: "absolute",
    top: 0,
    right: "25%",
    width: 46,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
    backgroundColor: theme?.colors?.primaryGhost,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: theme?.colors?.input,
    zIndex: 42,
    elevation: 42,
  },
  column: {
    position: "absolute",
    top: 22,
    right: "16%",
    gap: 6,
    padding: 6,
    borderRadius: theme?.layout?.borderRadius?.m ?? 12,
    backgroundColor: theme?.colors?.cardBackground,
    borderWidth: 1,
    borderColor: theme?.colors?.input,
    zIndex: 44,
    elevation: 44,
    ...theme?.shadows?.light,
  },
  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme?.layout?.borderRadius?.s ?? 8,
    backgroundColor: theme?.colors?.primaryGhost,
  },
  toolBtnPressed: { opacity: 0.6 },
  toolLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: theme?.colors?.primary,
  },
});
