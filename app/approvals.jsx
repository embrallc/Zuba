import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { useSubscriptionStore } from "../stores/useSubscriptionStore";
import { purchaseSeatCount } from "../utils/purchases";
import { supabase } from "../utils/supabase";

// Owner-facing seat-approvals inbox. Every teammate who joined with the org key
// beyond the paid seats shows here while they're in (or past) their 15-day
// grace. Approve = buy a seat ($19.99/mo). Deny = remove them (delete-user).
// The server (subscription-status) is the source of truth for this list.

const SEAT_PRICE = 19.99; // shown in the confirm copy; the store sheet shows the exact localized charge
const AMBER = "#CA8A04"; // in-grace clock (matches the walkthrough "low severity" amber)
const DAY_MS = 24 * 60 * 60 * 1000;

function daysLeft(iso) {
  const end = Date.parse(iso);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
}

function money(n) {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

function Navbar({ onBack }) {
  return (
    <View style={styles.navbar}>
      <TouchableOpacity
        onPress={onBack}
        hitSlop={theme?.layout?.hitSlop?.medium}
      >
        <MaterialCommunityIcons
          name="arrow-left"
          size={theme?.layout?.iconSize?.l}
          color={theme?.colors?.icon}
        />
      </TouchableOpacity>
      <Text style={styles.navTitle}>Approvals</Text>
      <View style={{ width: theme?.layout?.iconSize?.l }} />
    </View>
  );
}

export default function ApprovalsScreen() {
  const router = useRouter();
  const status = useSubscriptionStore((s) => s.status);
  const refreshStatus = useSubscriptionStore((s) => s.refreshStatus);

  const isOwner = status?.role === "owner";
  const isBillingOwner = status?.isBillingOwner === true;
  const billingOwnerName = status?.billingOwnerName ?? "your billing owner";
  const pending = status?.pendingApprovals ?? [];
  const seats = status?.seats ?? 0;
  const members = status?.members ?? 0;

  // null | userId | "all" — disables the whole list while one action runs.
  const [busy, setBusy] = useState(null);

  async function buySeats(targetSeats, who) {
    setBusy(who);
    try {
      await purchaseSeatCount(targetSeats);
      // Pull RevenueCat truth server-side now — the webhook can lag the purchase.
      await refreshStatus({ sync: true });
    } catch (e) {
      // The user backing out of the store sheet is not an error.
      if (!e?.userCancelled) {
        logError(e, "ApprovalsScreen.buySeats");
        Alert.alert(
          "Couldn't add the seat",
          e?.message ?? "The purchase didn't complete. Please try again.",
        );
      }
    } finally {
      setBusy(null);
    }
  }

  function confirmApprove({ count, targetSeats, who, note }) {
    const total = money(count * SEAT_PRICE);
    Alert.alert(
      count === 1 ? "Approve teammate?" : `Approve ${count} teammates?`,
      `This adds ${count} paid seat${count === 1 ? "" : "s"} to your plan — ${total}/mo more.` +
        (note ? `\n\n${note}` : ""),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Approve · ${total}/mo`,
          onPress: () => buySeats(targetSeats, who),
        },
      ],
    );
  }

  function onApproveOne() {
    confirmApprove({
      count: 1,
      targetSeats: seats + 1,
      who: "one",
      note: "Seats are granted to the longest-waiting teammate first.",
    });
  }

  function onApproveAll() {
    confirmApprove({ count: pending.length, targetSeats: members, who: "all" });
  }

  function onDeny(item) {
    Alert.alert(
      "Remove teammate?",
      `Remove ${item.name} from your organization. Their inspections and photos move to Unassigned Records so you can reassign them. They lose access immediately.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setBusy(item.id);
            try {
              const { data, error } = await supabase.functions.invoke(
                "delete-user",
                { body: { target_user_id: item.id } },
              );
              if (error) {
                let detail = error.message ?? "Could not remove teammate.";
                try {
                  const b = await error.context?.json?.();
                  if (b?.error) detail = b.error;
                } catch (_) {}
                throw new Error(detail);
              }
              if (data?.status !== "user_deleted") {
                throw new Error(data?.error ?? "Unexpected server response.");
              }
              await refreshStatus();
            } catch (e) {
              logError(e, `ApprovalsScreen.deny target=${item.id}`);
              Alert.alert("Couldn't remove", e?.message ?? "Please try again.");
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  function renderItem({ item }) {
    const rowBusy = busy === item.id;
    const locked = item.locked;
    return (
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.statusChip}>
            <MaterialCommunityIcons
              name={locked ? "lock" : "clock-outline"}
              size={13}
              color={locked ? theme?.colors?.error : AMBER}
            />
            <Text
              style={[
                styles.statusText,
                {
                  color: locked
                    ? theme?.colors?.error
                    : theme?.colors?.textSubtle,
                },
              ]}
            >
              {locked
                ? "Locked out"
                : `${daysLeft(item.graceEndsAt)}d left in grace`}
            </Text>
          </View>
        </View>

        {rowBusy ? (
          <ActivityIndicator size="small" color={theme?.colors?.primary} />
        ) : (
          <View style={styles.rowActions}>
            {isOwner && (
              <TouchableOpacity
                style={styles.denyBtn}
                onPress={() => onDeny(item)}
                disabled={!!busy}
                activeOpacity={0.75}
              >
                <Text style={styles.denyText}>Deny</Text>
              </TouchableOpacity>
            )}
            {isBillingOwner && (
              <TouchableOpacity
                style={styles.approveBtn}
                onPress={onApproveOne}
                disabled={!!busy}
                activeOpacity={0.85}
              >
                <Text style={styles.approveText}>Approve</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  }

  if (!isOwner && !isBillingOwner) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <Navbar onBack={() => router.back()} />
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="lock-outline"
            size={44}
            color={theme?.colors?.textFine}
          />
          <Text style={styles.emptyText}>
            Only an owner can manage seat approvals.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const allTotal = money(pending.length * SEAT_PRICE);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Navbar onBack={() => router.back()} />
      <FlatList
        data={pending}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          pending.length > 0 ? (
            <View style={styles.headerWrap}>
              <Text style={styles.helpText}>
                {pending.length} teammate{pending.length === 1 ? "" : "s"}{" "}
                joined with your org key and{" "}
                {pending.length === 1 ? "is" : "are"} using Zanbi on your plan.
                Approve to keep {pending.length === 1 ? "them" : "each"} at
                $19.99/mo per seat, or deny to remove. Seats are granted to the
                longest-waiting teammate first.
              </Text>
              {!isBillingOwner && (
                <Text style={styles.billingNote}>
                  {billingOwnerName} is the billing owner — only they can approve
                  new seats.
                  {isOwner ? " You can still deny (remove) a teammate." : ""}
                </Text>
              )}
              {isBillingOwner && pending.length > 1 && (
                <TouchableOpacity
                  style={styles.approveAllBtn}
                  onPress={onApproveAll}
                  disabled={!!busy}
                  activeOpacity={0.85}
                >
                  {busy === "all" ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.approveAllText}>
                      Approve all · {allTotal}/mo
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <MaterialCommunityIcons
              name="check-circle-outline"
              size={48}
              color={theme?.colors?.success}
            />
            <Text style={styles.emptyText}>
              You're all caught up — every teammate has a seat.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme?.colors?.mainBackground },
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
    paddingTop: theme?.spacing?.xl,
    gap: theme?.spacing?.s,
  },
  emptyText: {
    ...theme?.typography?.body,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
    paddingHorizontal: theme?.spacing?.xl,
  },
  list: {
    padding: theme?.spacing?.m,
    paddingBottom: theme?.spacing?.xxl,
  },
  headerWrap: {
    marginBottom: theme?.spacing?.m,
    gap: theme?.spacing?.m,
  },
  helpText: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
  },
  billingNote: {
    ...theme?.typography?.label,
    color: theme?.colors?.primary,
    fontWeight: "600",
  },
  approveAllBtn: {
    backgroundColor: theme?.colors?.primary,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: 12,
    alignItems: "center",
  },
  approveAllText: {
    color: "#fff",
    ...theme?.typography?.bodyBold,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme?.colors?.cardBackground,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    borderRadius: theme?.layout?.borderRadius?.m,
    marginBottom: theme?.spacing?.s,
    ...theme?.shadows?.light,
  },
  rowText: {
    flex: 1,
    marginRight: theme?.spacing?.s,
    gap: 4,
  },
  name: {
    ...theme?.typography?.bodyBold,
    flexShrink: 1,
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statusText: {
    ...theme?.typography?.caption,
    fontWeight: "600",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.s,
  },
  denyBtn: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: theme?.layout?.borderRadius?.full,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.input,
  },
  denyText: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    fontWeight: "700",
  },
  approveBtn: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: theme?.layout?.borderRadius?.full,
    backgroundColor: theme?.colors?.primary,
  },
  approveText: {
    ...theme?.typography?.label,
    color: "#fff",
    fontWeight: "700",
  },
});
