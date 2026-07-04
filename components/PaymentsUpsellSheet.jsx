import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";

// Shown when someone taps the invoice action but payments aren't set up yet.
// It replaces the old "enter an amount → then get told it's not enabled" dead
// end with an up-front pitch, tailored by role:
//   • owner → the pitch + a "Set Up Payments" button straight into Payment Setup
//     (only the owner can complete Stripe onboarding — it's tied to org banking).
//   • admin → the same pitch + a nudge to ask the owner (admins can't self-serve
//     the bank setup, but they're the ones who champion it upward).
// Basic members never see the invoice action pre-setup, so they never reach here.
//
// Props: visible, onClose(), userProfile.
export default function PaymentsUpsellSheet({ visible, onClose, userProfile }) {
  const router = useRouter();
  const isOwner = userProfile === "owner";

  function goSetup() {
    onClose?.();
    router.push("/payments-settings");
  }

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>

        <View style={styles.sheet}>
          <View style={styles.iconWrap}>
            <MaterialCommunityIcons
              name="cash-fast"
              size={40}
              color={theme.colors.primary}
            />
          </View>

          <Text style={styles.title}>Get paid on the spot</Text>

          <Text style={styles.body}>
            {isOwner
              ? "Text clients a secure invoice link right from an inspection. Money goes straight to your account — Zanbi just adds a small 1% fee."
              : "Your organization can text clients a secure invoice link right from an inspection, with money going straight to the owner's account. Ask your owner to turn on invoicing to unlock it."}
          </Text>

          {isOwner ? (
            <View style={styles.buttons}>
              <TouchableOpacity
                style={[styles.btn, styles.secondary]}
                onPress={onClose}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryTxt}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.primary]}
                onPress={goSetup}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryTxt}>Set Up Payments</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.buttons}>
              <TouchableOpacity
                style={[styles.btn, styles.primary]}
                onPress={onClose}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryTxt}>Got it</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
    paddingHorizontal: theme.spacing.l,
  },
  sheet: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    padding: theme.spacing.l,
    ...theme.shadows.medium,
  },
  iconWrap: { alignItems: "center", marginBottom: theme.spacing.s },
  title: { ...theme.typography.h4, textAlign: "center" },
  body: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    textAlign: "center",
    marginTop: theme.spacing.s,
    lineHeight: 20,
  },
  buttons: {
    flexDirection: "row",
    gap: theme.spacing.s,
    marginTop: theme.spacing.l,
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: theme.spacing.m,
    minHeight: 48,
  },
  secondary: { backgroundColor: theme.colors.input },
  secondaryTxt: { ...theme.typography.bodyBold, color: theme.colors.text },
  primary: { backgroundColor: theme.colors.primary, ...theme.shadows.light },
  primaryTxt: { ...theme.typography.bodyBold, color: "#fff" },
});
