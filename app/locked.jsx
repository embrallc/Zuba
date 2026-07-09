import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { logError } from "../db/logs";
import { useSubscriptionStore } from "../stores/useSubscriptionStore";
import { openManageSubscriptions, requestAccountDeletion } from "../utils/account";
import { isOnline } from "../utils/connectivity";
import {
  logOutPurchases,
  PAYWALL_RESULT,
  presentPaywall,
  restorePurchases,
} from "../utils/purchases";
import { signOutAndClear } from "../utils/supabase";

// Hard gate shown when the org is out of trial with no subscription, or the
// caller is outside the paid seat allowance. Routing in _layout.jsx forces
// this screen for locked states and routes back out the moment the server
// says we're clear — nothing here navigates to the app directly.
//
// Data is never touched: SQLite, cloud rows, and photos all stay put. The
// copy leans on that so a lapsed owner knows exactly what they're paying to
// get back into.

export default function LockedScreen() {
  const router = useRouter();
  const status = useSubscriptionStore((s) => s.status);
  const refreshStatus = useSubscriptionStore((s) => s.refreshStatus);
  const clearSubscription = useSubscriptionStore((s) => s.clear);

  const [busy, setBusy] = useState(null); // 'subscribe' | 'restore' | 'check' | 'signout' | 'delete'

  const role = status?.role ?? "member";
  const isOwner = role === "owner";
  const seatLocked = status?.state === "seat_locked";

  async function handleSubscribe() {
    if (busy) return;
    if (!isOnline()) {
      Alert.alert("You're offline", "Connect to the internet to subscribe.");
      return;
    }
    setBusy("subscribe");
    try {
      const result = await presentPaywall();
      if (
        result === PAYWALL_RESULT.PURCHASED ||
        result === PAYWALL_RESULT.RESTORED
      ) {
        // Pull RevenueCat truth server-side now — the webhook may lag the
        // purchase by a few seconds and the user is staring at this screen.
        await refreshStatus({ sync: true });
      }
    } catch (e) {
      logError(e, "LockedScreen.handleSubscribe");
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore() {
    if (busy) return;
    if (!isOnline()) {
      Alert.alert("You're offline", "Connect to the internet to restore purchases.");
      return;
    }
    setBusy("restore");
    try {
      await restorePurchases();
      await refreshStatus({ sync: true });
    } catch (e) {
      logError(e, "LockedScreen.handleRestore");
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckAgain() {
    if (busy) return;
    setBusy("check");
    try {
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function handleSignOut() {
    if (busy) return;
    setBusy("signout");
    try {
      await logOutPurchases();
      await signOutAndClear();
      clearSubscription();
      router.replace("/login");
    } catch (e) {
      logError(e, "LockedScreen.handleSignOut");
      setBusy(null);
    }
  }

  function handleDeleteAccount() {
    if (busy) return;
    Alert.alert(
      "Delete Account?",
      "This permanently deletes your account and data. If you have an active App Store subscription it is NOT cancelled automatically — manage it in your App Store settings.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Manage Subscriptions", onPress: openManageSubscriptions },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy("delete");
            try {
              const data = await requestAccountDeletion();
              if (data?.status === "blocked_sole_owner") {
                Alert.alert(
                  "Can't Delete Yet",
                  data.message ??
                    "You're the only owner of this organization. Promote another user to owner first.",
                );
                return;
              }
              await logOutPurchases();
              await signOutAndClear();
              clearSubscription();
              router.replace("/login");
            } catch (e) {
              logError(e, "LockedScreen.handleDeleteAccount");
              Alert.alert("Delete Failed", e.message ?? "Could not delete account.");
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  if (!status) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      </SafeAreaView>
    );
  }

  const copy = seatLocked
    ? {
        icon: "account-multiple-plus-outline",
        title: "Your team needs another seat",
        body: `Your organization's plan covers ${status?.seats ?? 0} ${
          (status?.seats ?? 0) === 1 ? "seat" : "seats"
        } and has ${status?.members ?? 0} members. Ask your organization owner to upgrade their plan, then check again. All of your work is saved.`,
      }
    : isOwner
      ? {
          icon: "lock-clock",
          title: "Your free trial has ended",
          body: "Everything you've built — inspections, clients, photos, and reports — is saved and waiting. Subscribe to pick up right where you left off.",
        }
      : {
          icon: "lock-clock",
          title: "Subscription needed",
          body: "Your organization's free trial has ended. Ask your organization owner to subscribe from their Zanbi app, then check again. All of your work is saved.",
        };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons
            name={copy.icon}
            size={44}
            color={theme?.colors?.primary}
          />
        </View>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>

        {isOwner && !seatLocked ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleSubscribe}
            disabled={!!busy}
            activeOpacity={0.85}
          >
            {busy === "subscribe" ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Subscribe</Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleCheckAgain}
            disabled={!!busy}
            activeOpacity={0.85}
          >
            {busy === "check" ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Check Again</Text>
            )}
          </TouchableOpacity>
        )}

        {isOwner && !seatLocked && (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={handleRestore}
            disabled={!!busy}
            activeOpacity={0.7}
          >
            {busy === "restore" ? (
              <ActivityIndicator size="small" color={theme?.colors?.primary} />
            ) : (
              <Text style={styles.secondaryBtnText}>Restore Purchases</Text>
            )}
          </TouchableOpacity>
        )}

        {isOwner && !seatLocked && (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={handleCheckAgain}
            disabled={!!busy}
            activeOpacity={0.7}
          >
            {busy === "check" ? (
              <ActivityIndicator size="small" color={theme?.colors?.primary} />
            ) : (
              <Text style={styles.secondaryBtnText}>Check Again</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.footer}>
        <TouchableOpacity onPress={handleSignOut} disabled={!!busy}>
          <Text style={styles.footerLink}>Sign Out</Text>
        </TouchableOpacity>
        <Text style={styles.footerDot}>·</Text>
        <TouchableOpacity onPress={handleDeleteAccount} disabled={!!busy}>
          <Text style={[styles.footerLink, styles.footerDanger]}>
            Delete Account
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
    justifyContent: "center",
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: theme?.colors?.primaryGhost ?? "#EEF2FF",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: theme?.colors?.text,
    textAlign: "center",
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
    marginBottom: 32,
  },
  primaryBtn: {
    backgroundColor: theme?.colors?.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignSelf: "stretch",
    alignItems: "center",
    marginBottom: 12,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  secondaryBtn: {
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
  secondaryBtnText: {
    color: theme?.colors?.primary,
    fontSize: 15,
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 24,
    gap: 12,
  },
  footerDot: {
    color: theme?.colors?.textSubtle,
  },
  footerLink: {
    fontSize: 14,
    color: theme?.colors?.textSubtle,
    fontWeight: "600",
    padding: 8,
  },
  footerDanger: {
    color: theme?.colors?.error,
  },
});
