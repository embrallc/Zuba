import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  getCompletedInspections,
  getDeletedInspections,
  restoreInspection,
  setInspectionStatus,
} from "../db/inspections";
import { logError } from "../db/logs";
import { useBannerStore } from "../stores/useBannerStore";
import { useInspectionStore } from "../stores/useInspectionStore";

// Single screen serving two archives, selected by the `type` param:
//   /archive?type=deleted    → soft-deleted rows (_deleted = 1)
//   /archive?type=completed  → completed rows (Status = 'CLOSED')
// Both let the user restore a record back into the active working set.
const CONFIG = {
  deleted: {
    title: "Deleted Inspections",
    icon: "trash-can-outline",
    empty: "Nothing here. Inspections you delete will show up so you can restore them.",
    actionLabel: "Restore",
    load: getDeletedInspections,
  },
  completed: {
    title: "Completed Inspections",
    icon: "check-circle-outline",
    empty: "Nothing here. Inspections you mark complete will show up so you can reopen them.",
    actionLabel: "Reopen",
    load: getCompletedInspections,
  },
};

export default function ArchiveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const type = params?.type === "completed" ? "completed" : "deleted";
  const config = CONFIG[type];

  const addToStore = useInspectionStore((s) => s.add);
  const showBanner = useBannerStore((s) => s.show);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    try {
      const data = await config.load();
      setRows(data ?? []);
    } catch (e) {
      logError(e, `ArchiveScreen.reload type=${type}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [config, type]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      reload();
    }, [reload]),
  );

  async function handleRestore(item) {
    if (busyId) return;
    const sk = item.InspectionSk;
    const label = item.FullName || "Inspection";
    setBusyId(sk);
    try {
      let restored;
      if (type === "completed") {
        restored = await setInspectionStatus(sk, "OPEN");
      } else {
        restored = await restoreInspection(sk);
      }
      // Re-add to the active store only if the row genuinely belongs there
      // (not deleted, not still CLOSED). Restoring a deleted-but-completed
      // row, for example, sends it back to the Completed archive instead.
      const active =
        restored &&
        !restored._deleted &&
        (restored.Status ?? "OPEN") !== "CLOSED";
      if (active) addToStore(restored);

      setRows((prev) => prev.filter((r) => r.InspectionSk !== sk));
      showBanner({
        message:
          type === "completed"
            ? `${label} reopened.`
            : active
              ? `${label} restored.`
              : `${label} restored to Completed.`,
        kind: "success",
      });
    } catch (e) {
      logError(e, `ArchiveScreen.handleRestore type=${type} sk=${sk}`);
      showBanner({ message: "Couldn't restore that inspection.", kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  function renderItem({ item }) {
    const name = item.FullName || "Unnamed Inspection";
    const when = item.ScheduledAt
      ? dayjs(item.ScheduledAt).format("MMM D, YYYY · h:mm A")
      : "No date";
    const address = [item.AddressLine1, item.City, item.State]
      .filter(Boolean)
      .join(", ");
    const isBusy = busyId === item.InspectionSk;

    return (
      <View style={styles.card}>
        <View style={styles.cardText}>
          <Text style={styles.cardName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.cardMeta}>{when}</Text>
          {address ? (
            <Text style={styles.cardMeta} numberOfLines={1}>
              {address}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.restoreBtn, isBusy && styles.restoreBtnDisabled]}
          onPress={() => handleRestore(item)}
          disabled={!!busyId}
          activeOpacity={0.8}
        >
          {isBusy ? (
            <ActivityIndicator size="small" color={theme?.colors?.primary} />
          ) : (
            <>
              <MaterialCommunityIcons
                name="restore"
                size={16}
                color={theme?.colors?.primary}
              />
              <Text style={styles.restoreText}>{config.actionLabel}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
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
        <Text style={styles.navTitle}>{config.title}</Text>
        <View style={{ width: theme?.layout?.iconSize?.l }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme?.colors?.primary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.InspectionSk}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons
                name={config.icon}
                size={theme?.layout?.iconSize?.xl}
                color={theme?.colors?.textFine}
              />
              <Text style={styles.emptyText}>{config.empty}</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    borderBottomWidth: theme?.layout?.borderWidth?.thin,
    borderBottomColor: theme?.colors?.input,
    ...theme?.shadows?.light,
  },
  navTitle: {
    ...theme?.typography?.h4,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    padding: theme?.spacing?.m,
    paddingBottom: theme?.spacing?.xxl,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  cardText: {
    flex: 1,
    marginRight: theme?.spacing?.m,
  },
  cardName: {
    ...theme?.typography?.bodyBold,
  },
  cardMeta: {
    ...theme?.typography?.label,
    marginTop: 2,
  },
  restoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.xs,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.xs,
    borderRadius: theme?.layout?.borderRadius?.full,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.primary,
    minWidth: 92,
    justifyContent: "center",
  },
  restoreBtnDisabled: {
    opacity: theme?.layout?.opacity?.disabled,
  },
  restoreText: {
    ...theme?.typography?.label,
    color: theme?.colors?.primary,
    fontWeight: "600",
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme?.spacing?.xxl,
    paddingHorizontal: theme?.spacing?.xl,
    gap: theme?.spacing?.m,
  },
  emptyText: {
    ...theme?.typography?.body,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
  },
});
