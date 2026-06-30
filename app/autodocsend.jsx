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

// Owner-only "what gets sent automatically on completion" settings. The report
// toggle is independent of Stripe — it only emails the report. The invoice +
// payment-gate toggles need a live Stripe account (they create a payment
// request / hold the report for payment), so they appear only once payments are
// set up. All three are org-level policy columns (synced), read/written the
// same way the Payment Setup screen reads the org's payment status.
export default function AutoDocSendScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userProfile = useSettingsStore((s) => s.userProfile);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const s = await getOrgPaymentStatus(orgSk);
    setStatus(s);
    setLoading(false);
  }, [orgSk]);

  useEffect(() => {
    reload();
  }, [reload]);

  const active = !!status?.stripe_charges_enabled;

  async function toggle(key, val) {
    const prev = status;
    setStatus((s) => ({ ...s, [key]: val }));
    try {
      await setOrgPaymentPolicy(orgSk, { [key]: val });
    } catch (e) {
      logError(e, `AutoDocSend.toggle ${key}`);
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
        <Text style={styles.navTitle}>Automatic Document Send</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {userProfile !== "owner" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Owner only</Text>
            <Text style={styles.cardBody}>
              Only the organization owner can change automatic sending.
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
            <Text style={styles.intro}>
              Choose what's sent to your client automatically when you complete
              an inspection.
            </Text>

            <SettingRow
              label="Auto-send report on complete"
              description="Email the client their report automatically when you complete the inspection."
              value={!!status?.auto_send_report}
              onValueChange={(v) => toggle("auto_send_report", v)}
            />

            {active ? (
              <>
                <Text style={styles.sectionLabel}>WITH PAYMENTS</Text>
                <SettingRow
                  label="Auto-send invoice on complete"
                  description="When you complete an inspection, automatically create and send the client a payment request."
                  value={!!status?.auto_send_invoice}
                  onValueChange={(v) => toggle("auto_send_invoice", v)}
                />
                <SettingRow
                  label="Require payment first"
                  description="Hold the report until the client has paid. Once payment clears, the report is released automatically."
                  value={!!status?.require_payment_first}
                  onValueChange={(v) => toggle("require_payment_first", v)}
                />
              </>
            ) : (
              <View style={styles.lockedCard}>
                <MaterialCommunityIcons
                  name="credit-card-outline"
                  size={20}
                  color={theme.colors.primary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.lockedTitle}>Want to bill clients too?</Text>
                  <Text style={styles.lockedBody}>
                    Set up payments to also auto-send invoices and hold reports
                    until the client pays.
                  </Text>
                  <TouchableOpacity
                    style={styles.lockedBtn}
                    onPress={() => router.push("/payments-settings")}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.lockedBtnText}>Set up payments</Text>
                  </TouchableOpacity>
                </View>
              </View>
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
  intro: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginBottom: theme.spacing.m,
    lineHeight: 19,
  },
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    marginBottom: theme.spacing.m,
    ...theme.shadows.light,
  },
  cardTitle: { ...theme.typography.bodyBold },
  cardBody: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginTop: 2,
    lineHeight: 19,
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
  lockedCard: {
    flexDirection: "row",
    gap: theme.spacing.s,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    marginTop: theme.spacing.s,
    ...theme.shadows.light,
  },
  lockedTitle: { ...theme.typography.bodyBold },
  lockedBody: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginTop: 2,
    lineHeight: 18,
  },
  lockedBtn: {
    alignSelf: "flex-start",
    marginTop: theme.spacing.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.full,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: 6,
  },
  lockedBtnText: {
    ...theme.typography.label,
    color: theme.colors.primary,
    fontWeight: "600",
  },
});
