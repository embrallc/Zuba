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
import { wipeDatabase } from "../db/devQuery";
import { logError, logEvent } from "../db/logs";
import { isOnline } from "../utils/connectivity";
import { supabase } from "../utils/supabase";

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgMode, setOrgMode] = useState("create"); // "create" | "join"
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sentTo, setSentTo] = useState(null); // email we sent a verify link to
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState(null);

  async function handleSubmit() {
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    if (mode === "signup") {
      if (orgMode === "create" && !orgName.trim()) {
        setError("Please enter your organization name.");
        return;
      }
      if (orgMode === "join" && !orgId.trim()) {
        setError("Please enter your organization ID.");
        return;
      }
    }

    setError(null);
    if (!isOnline()) {
      setError("You're offline — connect to the internet to continue.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        logEvent("auth.signin");
        router.replace("/(tabs)");
      } else {
        const metadata = orgMode === "create"
          ? { company_name: orgName.trim() }
          : { org_sk: orgId.trim() };

        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: metadata },
        });
        if (signUpError) throw signUpError;
        logEvent("auth.signup");

        // With email confirmation on, signUp returns no session — the account
        // isn't usable until the user taps the link in their inbox. Show a
        // "check your email" screen instead of bouncing to the tabs, which the
        // root layout would immediately kick back to login (looking broken).
        if (data?.session) {
          router.replace("/(tabs)");
        } else {
          setSentTo(email.trim());
        }
      }
    } catch (e) {
      logError(e, `login.handleSubmit:${mode}`);
      setError(e.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resending || !sentTo) return;
    if (!isOnline()) {
      setResendNote("You're offline — connect to the internet to resend.");
      return;
    }
    setResending(true);
    setResendNote(null);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: sentTo,
      });
      if (resendError) throw resendError;
      setResendNote("Sent — check your inbox again.");
    } catch (e) {
      logError(e, "login.handleResend");
      setResendNote(e.message ?? "Couldn't resend just now. Try again shortly.");
    } finally {
      setResending(false);
    }
  }

  function backToSignIn() {
    setSentTo(null);
    setResendNote(null);
    setError(null);
    setMode("signin");
  }

  function toggleMode() {
    setError(null);
    setOrgMode("create");
    setOrgName("");
    setOrgId("");
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

          {/* Post-signup: verification-pending screen */}
          {sentTo ? (
            <View style={styles.card}>
              <View style={styles.confirmIcon}>
                <MaterialCommunityIcons
                  name="email-check-outline"
                  size={36}
                  color={theme.colors.primary}
                />
              </View>
              <Text style={styles.confirmTitle}>Check your email</Text>
              <Text style={styles.confirmBody}>
                We sent a verification link to{" "}
                <Text style={styles.confirmEmail}>{sentTo}</Text>. Tap it to
                confirm your account, then come back here to sign in.
              </Text>
              <Text style={styles.confirmHint}>
                Don't see it? Check your spam folder — it can take a minute to
                arrive.
              </Text>

              {resendNote ? (
                <Text style={styles.resendNote}>{resendNote}</Text>
              ) : null}

              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={backToSignIn}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>Back to Sign In</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.toggleBtn}
                onPress={handleResend}
                disabled={resending}
              >
                <Text style={styles.toggleText}>
                  Didn't get it?{" "}
                  <Text style={styles.toggleLink}>
                    {resending ? "Sending…" : "Resend email"}
                  </Text>
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
          /* Card */
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
              returnKeyType={isSignIn ? "done" : "next"}
              onSubmitEditing={isSignIn ? handleSubmit : undefined}
            />

            {/* Org fields — signup only */}
            {!isSignIn && (
              <>
                <Text style={styles.label}>Organization</Text>
                <View style={styles.orgToggleRow}>
                  <TouchableOpacity
                    style={[styles.orgToggleBtn, orgMode === "create" && styles.orgToggleBtnSelected]}
                    onPress={() => { setOrgMode("create"); setOrgId(""); }}
                  >
                    <Text style={[styles.orgToggleText, orgMode === "create" && styles.orgToggleTextSelected]}>
                      Create New
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.orgToggleBtn, orgMode === "join" && styles.orgToggleBtnSelected]}
                    onPress={() => { setOrgMode("join"); setOrgName(""); }}
                  >
                    <Text style={[styles.orgToggleText, orgMode === "join" && styles.orgToggleTextSelected]}>
                      Join Existing
                    </Text>
                  </TouchableOpacity>
                </View>

                {orgMode === "create" ? (
                  <TextInput
                    style={styles.input}
                    value={orgName}
                    onChangeText={setOrgName}
                    placeholder="Your company or team name"
                    placeholderTextColor={theme.colors.textFine}
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit}
                  />
                ) : (
                  <>
                    <TextInput
                      style={styles.input}
                      value={orgId}
                      onChangeText={setOrgId}
                      placeholder="Organization ID from your owner"
                      placeholderTextColor={theme.colors.textFine}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      onSubmitEditing={handleSubmit}
                    />
                    <Text style={styles.hint}>
                      Ask your organization owner for the ID from their Settings screen.
                    </Text>
                  </>
                )}
              </>
            )}

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
              onLongPress={() => wipeDatabase()} //TESTING ONLY REMOVE AFTER DB ALL SET
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
          )}
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

  // Verification-pending card
  confirmIcon: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.input,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.m,
  },
  confirmTitle: {
    ...theme.typography.h3,
    color: theme.colors.text,
    textAlign: "center",
    marginBottom: theme.spacing.s,
  },
  confirmBody: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    lineHeight: 21,
  },
  confirmEmail: {
    color: theme.colors.text,
    fontWeight: "700",
  },
  confirmHint: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    textAlign: "center",
    marginTop: theme.spacing.m,
  },
  resendNote: {
    ...theme.typography.label,
    color: theme.colors.primary,
    textAlign: "center",
    marginTop: theme.spacing.m,
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
  hint: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    marginTop: theme.spacing.xs,
    marginHorizontal: theme.spacing.xs,
  },

  // Org toggle
  orgToggleRow: {
    flexDirection: "row",
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  orgToggleBtn: {
    flex: 1,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.layout.borderRadius.m,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    backgroundColor: theme.colors.mainBackground,
    alignItems: "center",
  },
  orgToggleBtnSelected: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  orgToggleText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
  },
  orgToggleTextSelected: {
    color: "#fff",
    fontWeight: "600",
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
