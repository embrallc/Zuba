import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { AnimatePresence, MotiView } from "moti";
import { Keyboard, StyleSheet, TouchableOpacity } from "react-native";

export default function KeyboardToolbar({
  visible,
  keyboardHeight,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  onSave,
}) {
  return (
    <AnimatePresence>
      {visible && (
        <MotiView
          key="toolbar"
          from={{ opacity: 0, translateY: 14 }}
          animate={{ opacity: 1, translateY: 0 }}
          exit={{ opacity: 0, translateY: 14 }}
          transition={{ type: "spring", damping: 20, stiffness: 280 }}
          style={[styles.toolbar, { bottom: keyboardHeight }]}
        >
          <TouchableOpacity
            onPress={() => Keyboard.dismiss()}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.btn}
          >
            <MaterialCommunityIcons
              name="keyboard-off-outline"
              size={24}
              color={theme.colors.icon}
            />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onPrev}
            disabled={!canGoPrev}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.btn}
          >
            <MaterialCommunityIcons
              name="chevron-left"
              size={26}
              color={canGoPrev ? theme.colors.primary : theme.colors.textFine}
            />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onNext}
            disabled={!canGoNext}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.btn}
          >
            <MaterialCommunityIcons
              name="chevron-right"
              size={26}
              color={canGoNext ? theme.colors.primary : theme.colors.textFine}
            />
          </TouchableOpacity>

          {onSave && (
            <TouchableOpacity
              onPress={onSave}
              hitSlop={theme.layout.hitSlop.medium}
              style={[styles.btn, styles.saveBtn]}
            >
              <MaterialCommunityIcons name="check" size={22} color="#fff" />
            </TouchableOpacity>
          )}
        </MotiView>
      )}
    </AnimatePresence>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.s,
    paddingVertical: theme.spacing.xs,
  },
  btn: {
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.m,
    backgroundColor: "rgba(231, 228, 228, 0.92)",
    ...theme.shadows.medium,
  },
  saveBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xs + 2,
    marginLeft: theme.spacing.xs,
    ...theme.shadows.medium,
  },
});
