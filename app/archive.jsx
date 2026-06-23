import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import RequestPaymentSheet from "../components/RequestPaymentSheet";
import {
  getCompletedInspections,
  getDeletedInspections,
  restoreInspection,
  setInspectionStatus,
} from "../db/inspections";
import { logError } from "../db/logs";
import { useBannerStore } from "../stores/useBannerStore";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";

// Single screen serving two archives, selected by the `type` param:
//   /archive?type=deleted    → soft-deleted rows (_deleted = 1)
//   /archive?type=completed  → completed rows (Status = 'CLOSED')
// Both let the user restore a record back into the active working set.

// Text columns the archive search scans (mirrors the My Day header search);
// the formatted date string is matched separately in `filtered`.
const SEARCH_FIELDS = [
  "FullName",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "ZipCode",
];

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
  const userProfile = useSettingsStore((s) => s.userProfile);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [payFor, setPayFor] = useState(null); // { sk, name } for the invoice sheet
  const [query, setQuery] = useState("");

  // Filter by name/address fields OR the formatted date string the row shows.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((i) => {
      if (SEARCH_FIELDS.some((f) => i[f]?.toLowerCase().includes(q))) return true;
      const when = i.ScheduledAt
        ? dayjs(i.ScheduledAt).format("MMM D, YYYY · h:mm A").toLowerCase()
        : "";
      return when.includes(q);
    });
  }, [rows, query]);

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
    const rb = type === "completed" ? reportBadge(item.ReportState) : null;

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
          {type === "completed" &&
          item.PaymentState &&
          item.PaymentState !== "none" ? (
            <View style={styles.payBadge}>
              <MaterialCommunityIcons
                name={item.Paid ? "check-circle" : "clock-outline"}
                size={13}
                color={item.Paid ? theme?.colors?.success : theme?.colors?.warning}
              />
              <Text
                style={[
                  styles.payBadgeTxt,
                  { color: item.Paid ? theme?.colors?.success : theme?.colors?.warning },
                ]}
              >
                {item.Paid ? "Paid" : "Payment requested"}
              </Text>
            </View>
          ) : null}
          {rb ? (
            <View style={styles.payBadge}>
              <MaterialCommunityIcons name={rb.icon} size={13} color={rb.color} />
              <Text style={[styles.payBadgeTxt, { color: rb.color }]}>
                {rb.label}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actionRow}>
          {type === "completed" && (
            <>
              <ActionPill
                icon="cash-plus"
                label="Invoice"
                disabled={!!busyId}
                onPress={() => setPayFor({ sk: item.InspectionSk, name })}
              />
              <ActionPill
                icon="file-document-outline"
                label="Report"
                disabled={!!busyId}
                onPress={() =>
                  router.push({
                    pathname: "/reportviewer",
                    params: { inspectionSk: item.InspectionSk },
                  })
                }
              />
            </>
          )}
          <ActionPill
            icon="restore"
            label={config.actionLabel}
            disabled={!!busyId}
            busy={isBusy}
            onPress={() => handleRestore(item)}
          />
        </View>
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

      {!loading && (rows.length > 0 || query.trim()) ? (
        <View style={styles.searchWrap}>
          <View style={styles.searchContainer}>
            <MaterialCommunityIcons
              name="magnify"
              size={theme?.layout?.iconSize?.m}
              color={theme?.colors?.icon}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search name, address, city, zip, or date…"
              placeholderTextColor={theme?.colors?.textFine}
              value={query}
              onChangeText={setQuery}
              clearButtonMode="while-editing"
              returnKeyType="search"
              autoCorrect={false}
            />
          </View>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme?.colors?.primary} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.InspectionSk}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons
                name={query.trim() ? "magnify-close" : config.icon}
                size={theme?.layout?.iconSize?.xl}
                color={theme?.colors?.textFine}
              />
              <Text style={styles.emptyText}>
                {query.trim()
                  ? "No inspections match your search."
                  : config.empty}
              </Text>
            </View>
          }
        />
      )}

      <RequestPaymentSheet
        visible={!!payFor}
        onClose={() => setPayFor(null)}
        inspectionSk={payFor?.sk}
        clientName={payFor?.name}
        userProfile={userProfile}
        onSuccess={() => reload()}
      />
    </SafeAreaView>
  );
}

// Maps the synced ReportState to a badge. 'pending' (nothing happened / manual
// path) shows nothing.
function reportBadge(state) {
  switch (state) {
    case "sent":
      return {
        icon: "email-check-outline",
        color: theme?.colors?.success,
        label: "Report sent",
      };
    case "held":
      return {
        icon: "lock-clock",
        color: theme?.colors?.warning,
        label: "Report held — awaiting payment",
      };
    case "sending":
      return {
        icon: "email-sync-outline",
        color: theme?.colors?.icon,
        label: "Sending report…",
      };
    case "failed":
      return {
        icon: "email-alert-outline",
        color: theme?.colors?.error,
        label: "Report send failed",
      };
    default:
      return null;
  }
}

function ActionPill({ icon, label, onPress, disabled, busy }) {
  return (
    <TouchableOpacity
      style={[styles.pill, disabled && styles.pillDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme?.colors?.primary} />
      ) : (
        <>
          <MaterialCommunityIcons
            name={icon}
            size={16}
            color={theme?.colors?.primary}
          />
          <Text style={styles.pillText}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
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
  searchWrap: {
    paddingHorizontal: theme?.spacing?.m,
    paddingTop: theme?.spacing?.m,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme?.colors?.input,
    borderRadius: theme?.layout?.borderRadius?.full,
    paddingHorizontal: theme?.spacing?.s,
    height: 38,
  },
  searchIcon: {
    marginRight: theme?.spacing?.xs,
  },
  searchInput: {
    flex: 1,
    ...theme?.typography?.body,
    paddingVertical: 0,
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
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  cardText: {},
  cardName: {
    ...theme?.typography?.bodyBold,
  },
  cardMeta: {
    ...theme?.typography?.label,
    marginTop: 2,
  },
  payBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: theme?.spacing?.xs,
  },
  payBadgeTxt: {
    ...theme?.typography?.label,
    fontWeight: "600",
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme?.spacing?.s,
    marginTop: theme?.spacing?.m,
  },
  pill: {
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
  pillDisabled: {
    opacity: theme?.layout?.opacity?.disabled,
  },
  pillText: {
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
