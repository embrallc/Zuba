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
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { logError } from "../db/logs";
import {
  getOrgPaymentStatus,
  setOrgPaymentPolicy,
} from "../db/organizations";
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
      await reload();
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

  async function toggle(key, val) {
    const prev = status;
    setStatus((s) => ({ ...s, [key]: val }));
    try {
      await setOrgPaymentPolicy(orgSk, { [key]: val });
    } catch (e) {
      logError(e, `PaymentsSettings.toggle ${key}`);
      setStatus(prev);
      Alert.alert("Couldn't save", "That setting didn't save. Please try again.");
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
        <Text style={styles.navTitle}>Payments</Text>
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

            {/* Policy toggles — owner decides the report/payment flow */}
            {active && (
              <>
                <Text style={styles.sectionLabel}>REPORT &amp; PAYMENT FLOW</Text>
                <SettingRow
                  label="Auto-send invoice on complete"
                  description="When you complete an inspection, automatically create and send the client a payment request."
                  value={!!status?.auto_send_invoice}
                  onValueChange={(v) => toggle("auto_send_invoice", v)}
                />
                <SettingRow
                  label="Auto-send report on complete"
                  description="Email the client their report automatically when the inspection is completed."
                  value={!!status?.auto_send_report}
                  onValueChange={(v) => toggle("auto_send_report", v)}
                />
                <SettingRow
                  label="Require payment first"
                  description="Hold the report until the client has paid. Once payment clears, the report is released automatically."
                  value={!!status?.require_payment_first}
                  onValueChange={(v) => toggle("require_payment_first", v)}
                />
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingRow({ label, description, value, onValueChange }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {description ? (
          <Text style={styles.rowDescription}>{description}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.input, true: theme.colors.primary }}
        thumbColor="#fff"
      />
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
