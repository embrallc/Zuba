import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { randomUUID } from "expo-crypto";
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
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;

      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (signUpError) throw signUpError;

        const uid = data.user.id;

        if (orgMode === "create") {
          const newOrgSk = randomUUID();

          const { error: orgErr } = await supabase
            .from("organizations")
            .insert({ org_sk: newOrgSk, org_name: orgName.trim(), user_id: uid });
          if (orgErr) throw orgErr;

          const { error: userErr } = await supabase
            .from("users")
            .insert({ id: uid, user_sk: uid, org_sk: newOrgSk, user_profile: "owner" });
          if (userErr) throw userErr;

        } else {
          const { data: org, error: lookupErr } = await supabase
            .from("organizations")
            .select("org_sk")
            .eq("org_sk", orgId.trim())
            .single();
          if (lookupErr || !org) {
            throw new Error("Organization not found. Double-check the ID and try again.");
          }

          const { error: userErr } = await supabase
            .from("users")
            .insert({ id: uid, user_sk: uid, org_sk: org.org_sk, user_profile: "member" });
          if (userErr) throw userErr;
        }
      }

      router.replace("/(tabs)");
    } catch (e) {
      setError(e.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
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
