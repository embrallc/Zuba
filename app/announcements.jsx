import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSettingsStore } from "../stores/useSettingsStore";

// Category → chip label + accent color. Unknown categories fall back to Update.
const CATEGORY = {
  update: { label: "Update", color: theme?.colors?.primary },
  release: { label: "Release", color: theme?.colors?.success },
  outage: { label: "Outage", color: theme?.colors?.warning },
};

function NotifCard({ item, expanded, onToggle }) {
  const cat = CATEGORY[item.category] ?? CATEGORY.update;
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onToggle}
      activeOpacity={0.75}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderText}>
          <View style={styles.metaRow}>
            <View style={[styles.chip, { backgroundColor: cat.color }]}>
              <Text style={styles.chipText}>{cat.label}</Text>
            </View>
            <Text style={styles.date}>
              {dayjs(item.published_at).format("MMM D, YYYY")}
            </Text>
          </View>
          <Text
            style={styles.title}
            numberOfLines={expanded ? undefined : 2}
          >
            {item.title}
          </Text>
        </View>
        <MaterialCommunityIcons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={22}
          color={theme?.colors?.textSubtle}
        />
      </View>

      {expanded && <Text style={styles.body}>{item.body}</Text>}
    </TouchableOpacity>
  );
}

export default function AnnouncementsScreen() {
  const router = useRouter();
  const productNotifs = useSettingsStore((s) => s.productNotifs);
  const refreshProductNotifs = useSettingsStore((s) => s.refreshProductNotifs);
  const markProductNotifsViewed = useSettingsStore(
    (s) => s.markProductNotifsViewed,
  );

  const [expanded, setExpanded] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  // On open: clear the unread badge (everything is now "seen") and pull the
  // freshest list.
  useEffect(() => {
    markProductNotifsViewed?.();
    refreshProductNotifs?.();
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshProductNotifs?.();
    } finally {
      setRefreshing(false);
    }
  }

  const toggle = (id) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme?.layout?.iconSize?.l}
            color={theme?.colors?.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle}>Product Notifications</Text>
        <View style={{ width: theme?.layout?.iconSize?.l }} />
      </View>

      <FlatList
        data={productNotifs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme?.colors?.primary}
          />
        }
        renderItem={({ item }) => (
          <NotifCard
            item={item}
            expanded={!!expanded[item.id]}
            onToggle={() => toggle(item.id)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialCommunityIcons
              name="bell-outline"
              size={40}
              color={theme?.colors?.textFine}
            />
            <Text style={styles.emptyText}>
              No announcements yet. Updates, releases, and service notices will
              show up here.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    backgroundColor: theme.colors.cardBackground,
    borderBottomWidth: theme.layout.borderWidth.thin,
    borderBottomColor: theme.colors.input,
    ...theme.shadows.light,
  },
  navTitle: {
    ...theme.typography.h4,
  },
  content: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
    gap: theme.spacing.s,
    flexGrow: 1,
  },
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    ...theme.shadows.light,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.s,
  },
  cardHeaderText: {
    flex: 1,
    gap: 4,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
  },
  chip: {
    paddingHorizontal: theme.spacing.s,
    paddingVertical: 2,
    borderRadius: theme.layout.borderRadius.s,
  },
  chipText: {
    ...theme.typography.caption,
    color: "#fff",
    fontWeight: "700",
  },
  date: {
    ...theme.typography.caption,
    color: theme.colors.textSubtle,
  },
  title: {
    ...theme.typography.bodyBold,
    color: theme.colors.text,
  },
  body: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.s,
    lineHeight: 22,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.xl,
    gap: theme.spacing.s,
    marginTop: theme.spacing.xxl,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textFine,
    textAlign: "center",
  },
});
