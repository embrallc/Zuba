import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../utils/supabase";

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
      }

      // ── RevenueCat entitlement check (pending Apple Developer approval) ──────
      // After successful sign-in, check if the user has an active "Embra LLC Pro"
      // entitlement before navigating. Wire this in once the dev build is ready:
      //
      // const result = await RevenueCatUI.presentPaywallIfNeeded({
      //   requiredEntitlementIdentifier: ENTITLEMENT_ID,
      // });
      // ────────────────────────────────────────────────────────────────────────

      router.replace("/(tabs)");
    } catch (e) {
      setError(e.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function toggleMode() {
    setError(null);
    setMode((m) => (m === "signin" ? "signup" : "signin"));
  }

  const isSignIn = mode === "signin";

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo / brand */}
          <View style={styles.brand}>
            <View style={styles.logoCircle}>
              <MaterialCommunityIcons
                name="clipboard-check-outline"
                size={42}
                color="#fff"
              />
            </View>
            <Text style={styles.appName}>Embra</Text>
            <Text style={styles.tagline}>Home Inspection Management</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {isSignIn ? "Welcome back" : "Create your account"}
            </Text>

            {error ? (
              <View style={styles.errorRow}>
                <MaterialCommunityIcons
                  name="alert-circle-outline"
                  size={16}
                  color={theme.colors.error}
                />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={theme.colors.textFine}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder={isSignIn ? "Your password" : "At least 6 characters"}
              placeholderTextColor={theme.colors.textFine}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />

            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {isSignIn ? "Sign In" : "Create Account"}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.toggleBtn}
              onPress={toggleMode}
              disabled={loading}
            >
              <Text style={styles.toggleText}>
                {isSignIn
                  ? "Don't have an account? "
                  : "Already have an account? "}
                <Text style={styles.toggleLink}>
                  {isSignIn ? "Sign up" : "Sign in"}
                </Text>
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.xl,
  },

  // Brand
  brand: {
    alignItems: "center",
    marginBottom: theme.spacing.xl,
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.m,
    ...theme.shadows.medium,
  },
  appName: {
    ...theme.typography.h1,
    color: theme.colors.text,
    letterSpacing: 1,
  },
  tagline: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginTop: theme.spacing.xs,
  },

  // Card
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    padding: theme.spacing.l,
    ...theme.shadows.medium,
  },
  cardTitle: {
    ...theme.typography.h3,
    color: theme.colors.text,
    marginBottom: theme.spacing.m,
  },

  // Error
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    backgroundColor: "rgba(220,38,38,0.08)",
    borderRadius: theme.layout.borderRadius.s,
    padding: theme.spacing.s,
    marginBottom: theme.spacing.m,
  },
  errorText: {
    ...theme.typography.label,
    color: theme.colors.error,
    flex: 1,
  },

  // Inputs
  label: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginBottom: theme.spacing.xs,
    marginTop: theme.spacing.s,
  },
  input: {
    backgroundColor: theme.colors.input,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: 12,
    ...theme.typography.body,
    color: theme.colors.text,
  },

  // Buttons
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: theme.spacing.l,
    ...theme.shadows.light,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    ...theme.typography.bodyBold,
    color: "#fff",
  },
  toggleBtn: {
    alignItems: "center",
    paddingVertical: theme.spacing.m,
    marginTop: theme.spacing.xs,
  },
  toggleText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },
  toggleLink: {
    color: theme.colors.primary,
    fontWeight: "700",
  },
});
