import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { Tabs } from "expo-router";
import { AnimatePresence, MotiView } from "moti";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function AnimatedTabIcon({ name, focused, color, size }) {
  return (
    <View style={{ alignItems: "center", paddingTop: 2 }}>
      <MotiView
        animate={{ scale: focused ? 1.12 : 1, translateY: focused ? -1 : 0 }}
        transition={{ type: "spring", damping: 14, stiffness: 200 }}
      >
        <MaterialCommunityIcons name={name} color={color} size={size} />
      </MotiView>

      <AnimatePresence>
        {focused && (
          <MotiView
            key="dot"
            from={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.3 }}
            transition={{ type: "spring", damping: 13, stiffness: 200 }}
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: theme.colors.primary,
              marginTop: 3,
            }}
          />
        )}
        {!focused && (
          <View key="spacer" style={{ width: 5, height: 5, marginTop: 3 }} />
        )}
      </AnimatePresence>
    </View>
  );
}

export default function TabsLayout() {
  // Bottom safe-area inset (home indicator on notched iPhones / gesture-nav
  // Androids). Supplying an explicit numeric `height` to tabBarStyle overrides
  // React Navigation's built-in inset math, so we add the inset ourselves —
  // otherwise the icons/labels sit crammed against the home indicator.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        freezeOnBlur: false,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.cardBackground,
          borderTopWidth: 0,
          shadowColor: theme.colors.primary,
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.1,
          shadowRadius: 16,
          elevation: 16,
          height: 62 + insets.bottom,
          paddingBottom: 6 + insets.bottom,
          paddingTop: 4,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.icon,
        tabBarLabelStyle: {
          ...theme.typography.caption,
          fontWeight: "600",
          color: undefined,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "My Day",
          tabBarIcon: ({ focused, color, size }) => (
            <AnimatedTabIcon
              name="calendar-today"
              focused={focused}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="inspections"
        options={{
          title: "Inspections",
          tabBarIcon: ({ focused, color, size }) => (
            <AnimatedTabIcon
              name="format-list-bulleted"
              focused={focused}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="weekview"
        options={{
          title: "Week",
          tabBarIcon: ({ focused, color, size }) => (
            <AnimatedTabIcon
              name="calendar-week"
              focused={focused}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="monthview"
        options={{
          title: "Month",
          tabBarIcon: ({ focused, color, size }) => (
            <AnimatedTabIcon
              name="calendar-month"
              focused={focused}
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}
