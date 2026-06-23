import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { getInspectionById } from "../db/inspections";
import { listPayments } from "../db/payments";
import { shareCheckoutLink } from "../utils/payments";

const STATUS_META = {
  paid: { label: "Paid", color: theme.colors.success, icon: "check-circle" },
  open: { label: "Awaiting payment", color: theme.colors.warning, icon: "clock-outline" },
  created: { label: "Awaiting payment", color: theme.colors.warning, icon: "clock-outline" },
  expired: { label: "Expired", color: theme.colors.textSubtle, icon: "close-circle-outline" },
  canceled: { label: "Canceled", color: theme.colors.textSubtle, icon: "close-circle-outline" },
  refunded: { label: "Refunded", color: theme.colors.error, icon: "cash-refund" },
};

function money(cents, currency = "usd") {
  const v = (Number(cents) || 0) / 100;
  const sym = currency === "usd" ? "$" : "";
  return `${sym}${v.toFixed(2)}`;
}

export default function PaymentsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const payments = await listPayments({ limit: 200 });
    // Resolve a display label per row from the local inspection mirror.
    const withLabels = await Promise.all(
      payments.map(async (p) => {
        const insp = await getInspectionById(p.inspection_sk);
        const name = insp?.FullName || "";
        const addr = [insp?.AddressLine1, insp?.City].filter(Boolean).join(", ");
        return { ...p, _label: name || addr || "Inspection", _sub: name ? addr : "" };
      }),
    );
    setRows(withLabels);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  function renderItem({ item }) {
    const meta = STATUS_META[item.status] ?? STATUS_META.open;
    const canShare = (item.status === "open" || item.status === "created") && !!item.checkout_url;
    const when = item.paid_at || item.created_at;
    return (
      <View style={styles.row}>
        <View style={styles.rowTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel} numberOfLines={1}>
              {item._label}
            </Text>
            {item._sub ? (
              <Text style={styles.rowSub} numberOfLines={1}>
                {item._sub}
              </Text>
            ) : null}
          </View>
          <Text style={styles.amount}>{money(item.amount_cents, item.currency)}</Text>
        </View>

        <View style={styles.rowBottom}>
          <View style={styles.statusChip}>
            <MaterialCommunityIcons name={meta.icon} size={15} color={meta.color} />
            <Text style={[styles.statusTxt, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Text style={styles.date}>
            {when ? dayjs(when).format("MMM D, YYYY") : ""}
          </Text>
        </View>

        {canShare && (
          <TouchableOpacity
            style={styles.shareBtn}
            activeOpacity={0.8}
            onPress={() => shareCheckoutLink(item.checkout_url, item._label)}
          >
            <MaterialCommunityIcons
              name="share-variant"
              size={16}
              color={theme.colors.primary}
            />
            <Text style={styles.shareTxt}>Share link again</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme.layout.iconSize.l}
            color={theme.colors.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle}>Payment Activity</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      {loading ? (
        <ActivityIndicator
          size="large"
          color={theme.colors.primary}
          style={{ marginTop: theme.spacing.xl }}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.payment_request_sk}
          renderItem={renderItem}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons
                name="cash-multiple"
                size={40}
                color={theme.colors.textFine}
              />
              <Text style={styles.emptyText}>
                No payment requests yet. Swipe an inspection and tap the $ button
                to bill a client.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.mainBackground },
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
  navTitle: { ...theme.typography.h4 },
  content: { padding: theme.spacing.m, paddingBottom: theme.spacing.xxl, flexGrow: 1 },
  row: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing.s },
  rowLabel: { ...theme.typography.bodyBold },
  rowSub: { ...theme.typography.label, color: theme.colors.textSubtle, marginTop: 1 },
  amount: { ...theme.typography.h4, color: theme.colors.text },
  rowBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing.s,
  },
  statusChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  statusTxt: { ...theme.typography.label, fontWeight: "600" },
  date: { ...theme.typography.caption },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: theme.spacing.s,
    paddingVertical: 6,
  },
  shareTxt: { ...theme.typography.label, color: theme.colors.primary, fontWeight: "600" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.m,
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.xxl,
  },
  emptyText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    textAlign: "center",
    lineHeight: 20,
  },
});
