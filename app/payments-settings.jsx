import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { logError } from "../db/logs";
import { getOrgPaymentStatus } from "../db/organizations";
import { useSettingsStore } from "../stores/useSettingsStore";
import { refreshPaymentStatus, startStripeOnboarding } from "../utils/payments";

export default function PaymentsSettingsScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userProfile = useSettingsStore((s) => s.userProfile);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    const s = await getOrgPaymentStatus(orgSk);
    setStatus(s);
    setLoading(false);
  }, [orgSk]);

  useEffect(() => {
    reload();
  }, [reload]);

  const notStarted = !status?.stripe_account_id;
  const active = !!status?.stripe_charges_enabled;
  const pending = !!status?.stripe_account_id && !active;

  async function handleSetup() {
    if (busy) return;
    setBusy(true);
    try {
      await startStripeOnboarding();
      // Regardless of how the browser closed, pull the live capability flags.
      await refreshPaymentStatus();
      const fresh = await getOrgPaymentStatus(orgSk);
      setStatus(fresh);
      setLoading(false);
      // Newly live → take them straight to Automatic Document Send so they see
      // the invoice + payment-gate toggles that just unlocked.
      if (fresh?.stripe_charges_enabled) {
        router.push("/autodocsend");
      }
    } catch (e) {
      logError(e, "PaymentsSettings.handleSetup");
      Alert.alert(
        "Couldn't start setup",
        e?.message ||
          "We couldn't open the Stripe setup page. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshPaymentStatus();
      await reload();
    } catch (e) {
      logError(e, "PaymentsSettings.handleRefresh");
    } finally {
      setRefreshing(false);
    }
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
        <Text style={styles.navTitle}>Payment Setup</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {userProfile !== "owner" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Owner only</Text>
            <Text style={styles.cardBody}>
              Only the organization owner can set up payments.
            </Text>
          </View>
        ) : loading ? (
          <ActivityIndicator
            size="large"
            color={theme.colors.primary}
            style={{ marginTop: theme.spacing.xl }}
          />
        ) : (
          <>
            {/* Status card */}
            <View style={styles.card}>
              <View style={styles.statusRow}>
                <MaterialCommunityIcons
                  name={
                    active
                      ? "check-circle"
                      : pending
                        ? "progress-clock"
                        : "credit-card-outline"
                  }
                  size={22}
                  color={
                    active
                      ? theme.colors.success
                      : pending
                        ? theme.colors.warning
                        : theme.colors.primary
                  }
                />
                <Text style={styles.cardTitle}>
                  {active
                    ? "Payments active"
                    : pending
                      ? "Finishing setup"
                      : "Set up payments"}
                </Text>
              </View>
              <Text style={styles.cardBody}>
                {active
                  ? "You can bill clients from any inspection. Money goes straight to your connected account — Kensa keeps a 1% fee."
                  : pending
                    ? "Stripe is still verifying your details. Tap Continue if it asked for more, or Refresh once it's done."
                    : "Connect a Stripe account to bill clients with a secure payment link. You enter your banking details on Stripe — Kensa never sees them."}
              </Text>

              {!active && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
                  onPress={handleSetup}
                  disabled={busy}
                  activeOpacity={0.85}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnPrimaryTxt}>
                      {pending ? "Continue setup" : "Set Up Payments"}
                    </Text>
                  )}
                </TouchableOpacity>
              )}

              {pending && (
                <TouchableOpacity
                  style={styles.refreshLink}
                  onPress={handleRefresh}
                  disabled={refreshing}
                  activeOpacity={0.7}
                >
                  {refreshing ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (
                    <Text style={styles.refreshTxt}>Refresh status</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Once live: account status + a pointer to Automatic Document
                Send, which is where the report / invoice / payment-gate toggles
                now live (the report toggle works with or without payments). */}
            {active && (
              <>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Account</Text>
                  <InfoRow
                    label="Charges enabled"
                    ok={!!status?.stripe_charges_enabled}
                  />
                  <InfoRow
                    label="Payouts enabled"
                    ok={!!status?.stripe_payouts_enabled}
                  />
                  <InfoRow
                    label="Details submitted"
                    ok={!!status?.stripe_details_submitted}
                  />
                  {status?.stripe_account_id ? (
                    <Text style={styles.acctId}>
                      Account {status.stripe_account_id}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardBody}>
                    Choose what's sent automatically when you complete an
                    inspection — including auto-sending invoices and holding
                    reports until the client pays — in Automatic Document Send.
                  </Text>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={() => router.push("/autodocsend")}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.btnPrimaryTxt}>
                      Automatic Document Send
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ label, ok }) {
  return (
    <View style={styles.infoRow}>
      <MaterialCommunityIcons
        name={ok ? "check-circle" : "progress-clock"}
        size={16}
        color={ok ? theme.colors.success : theme.colors.warning}
      />
      <Text style={styles.infoLabel}>{label}</Text>
    </View>
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
  content: { padding: theme.spacing.m, paddingBottom: theme.spacing.xxl },
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    marginBottom: theme.spacing.m,
    ...theme.shadows.light,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    marginBottom: theme.spacing.s,
  },
  cardTitle: { ...theme.typography.bodyBold },
  cardBody: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginTop: 2,
    lineHeight: 19,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: theme.spacing.m,
    marginTop: theme.spacing.m,
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: theme.colors.primary, ...theme.shadows.medium },
  btnPrimaryTxt: { ...theme.typography.bodyBold, color: "#fff" },
  btnDisabled: { opacity: theme.layout.opacity.disabled },
  refreshLink: { alignItems: "center", paddingVertical: theme.spacing.s, marginTop: theme.spacing.xs },
  refreshTxt: { ...theme.typography.label, color: theme.colors.primary, fontWeight: "600" },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    marginTop: theme.spacing.s,
  },
  infoLabel: { ...theme.typography.label, color: theme.colors.text },
  acctId: {
    ...theme.typography.caption,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.s,
  },
  sectionLabel: {
    ...theme.typography.overline,
    marginTop: theme.spacing.s,
    marginBottom: theme.spacing.s,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  rowText: { flex: 1, marginRight: theme.spacing.m },
  rowLabel: { ...theme.typography.bodyBold },
  rowDescription: { ...theme.typography.label, marginTop: 2, lineHeight: 18 },
});
