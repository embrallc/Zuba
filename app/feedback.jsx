import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError, logEvent } from "../db/logs";
import { useSettingsStore } from "../stores/useSettingsStore";
import { FEEDBACK_MAX, submitFeedback } from "../utils/feedback";

export default function FeedbackScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !submitting;
  const remaining = FEEDBACK_MAX - text.length;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitFeedback({ body: trimmed, orgSk });
      if (res.ok) {
        logEvent("feedback.submitted", { length: trimmed.length });
        setSubmitted(true);
      } else if (res.error === "offline") {
        setError("You're offline — reconnect and try again.");
      } else {
        logError(new Error(res.error), "feedback.submit");
        setError("Couldn't send that just now. Please try again.");
      }
    } catch (e) {
      logError(e, "feedback.submit");
      setError("Couldn't send that just now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={theme?.layout?.iconSize?.l}
            color={theme?.colors?.icon}
          />
        </TouchableOpacity>
        <Text style={styles.navTitle}>Ideas & Feedback</Text>
        <View style={{ width: theme?.layout?.iconSize?.l }} />
      </View>

      {submitted ? (
        <View style={styles.thanks}>
          <View style={styles.thanksIcon}>
            <MaterialCommunityIcons
              name="check-circle-outline"
              size={44}
              color={theme?.colors?.success}
            />
          </View>
          <Text style={styles.thanksTitle}>Thanks for sharing!</Text>
          <Text style={styles.thanksBody}>
            We read every note — it genuinely shapes what we build next.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.back()}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.intro}>
              Use this section to let us know of possible new features that would
              work well for you, feedback on the current app, or any issues
              you're experiencing.
            </Text>

            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={(t) => {
                  setText(t);
                  if (error) setError(null);
                }}
                placeholder="Type your idea, feedback, or issue…"
                placeholderTextColor={theme?.colors?.textSubtle}
                multiline
                textAlignVertical="top"
                maxLength={FEEDBACK_MAX}
                editable={!submitting}
                autoFocus
              />
              <Text
                style={[
                  styles.counter,
                  remaining <= 50 && { color: theme?.colors?.warning },
                ]}
              >
                {remaining}
              </Text>
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Send</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.mainBackground,
  },
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
  navTitle: {
    ...theme.typography.h4,
  },
  content: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
  },
  intro: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    marginBottom: theme.spacing.l,
  },
  inputWrap: {
    position: "relative",
  },
  input: {
    ...theme.typography.body,
    color: theme.colors.text,
    backgroundColor: theme.colors.cardBackground,
    borderWidth: theme.layout.borderWidth.thin,
    borderColor: theme.colors.input,
    borderRadius: theme.layout.borderRadius.m,
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xl,
    minHeight: 180,
  },
  counter: {
    position: "absolute",
    right: theme.spacing.m,
    bottom: theme.spacing.s,
    ...theme.typography.caption,
    color: theme.colors.textFine,
  },
  error: {
    ...theme.typography.label,
    color: theme.colors.error,
    marginTop: theme.spacing.s,
  },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: theme.spacing.m,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.l,
    minHeight: 50,
    ...theme.shadows.medium,
  },
  primaryBtnDisabled: {
    opacity: theme.layout.opacity.disabled,
  },
  primaryBtnText: {
    ...theme.typography.bodyBold,
    color: "#fff",
  },
  thanks: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.xl,
    gap: theme.spacing.s,
  },
  thanksIcon: {
    marginBottom: theme.spacing.xs,
  },
  thanksTitle: {
    ...theme.typography.h3,
    textAlign: "center",
  },
  thanksBody: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    marginBottom: theme.spacing.m,
  },
});
