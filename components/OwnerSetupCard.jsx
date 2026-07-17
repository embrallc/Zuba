import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { shareFormBuilderLink } from "../utils/formBuilder";

// First-run setup guidance for a new owner, shown in the My Day dashboard slot
// (see useOwnerSetup for the once-per-org gating). The builder is a computer
// experience, so the primary action shares the link for the owner to open on a
// PC rather than opening the phone browser.
function Step({ done, text }) {
  return (
    <View style={styles.step}>
      <MaterialCommunityIcons
        name={done ? "check-circle" : "circle-outline"}
        size={theme?.layout?.iconSize?.m ?? 22}
        color={done ? theme?.colors?.success ?? "#1f9d63" : theme?.colors?.textFine}
      />
      <Text style={[styles.stepText, done && styles.stepTextDone]}>{text}</Text>
    </View>
  );
}

export default function OwnerSetupCard({ hasForm = false, onDismiss }) {
  const [sharing, setSharing] = useState(false);

  async function handleShare() {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await shareFormBuilderLink();
      if (!res.ok && res.reason === "offline") {
        Alert.alert(
          "You're offline",
          "Connect to the internet to create your builder link.",
        );
      } else if (!res.ok) {
        Alert.alert(
          "Couldn't create the link",
          "Something went wrong. Please try again in a moment.",
        );
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <View style={styles.card}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons
            name="clipboard-edit-outline"
            size={30}
            color={theme?.colors?.primary}
          />
        </View>

        <Text style={styles.title}>Let's set up your inspections</Text>
        <Text style={styles.body}>
          Before your first inspection, design your walkthrough form and its
          report. The builder is a drag-and-drop tool that works best on a
          computer — we'll create a private link you can email to yourself and
          open on your PC.
        </Text>

        <View style={styles.steps}>
          <Step done={hasForm} text="Design & publish your walkthrough form" />
          <Step done={hasForm} text="Design & publish your report layout" />
          <Step done={false} text="Add your first inspection" />
        </View>

        <TouchableOpacity
          style={[styles.primaryBtn, sharing && styles.primaryBtnDisabled]}
          onPress={handleShare}
          disabled={sharing}
          activeOpacity={0.85}
        >
          {sharing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialCommunityIcons name="email-outline" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Email myself the builder link</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.dismissBtn}
          onPress={onDismiss}
          hitSlop={theme?.layout?.hitSlop?.medium}
        >
          <Text style={styles.dismissText}>
            {hasForm ? "Done — hide this" : "I'll do this later"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.l,
    ...theme?.shadows?.medium,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme?.spacing?.l,
    gap: theme?.spacing?.s,
  },
  iconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme?.colors?.input,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme?.spacing?.xs,
  },
  title: {
    ...theme?.typography?.h3,
    color: theme?.colors?.text,
    textAlign: "center",
  },
  body: {
    ...theme?.typography?.body,
    color: theme?.colors?.textSubtle,
    textAlign: "center",
    lineHeight: 20,
  },
  steps: {
    alignSelf: "stretch",
    gap: theme?.spacing?.xs,
    marginTop: theme?.spacing?.s,
    marginBottom: theme?.spacing?.s,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.s,
  },
  stepText: {
    ...theme?.typography?.body,
    color: theme?.colors?.text,
    flex: 1,
  },
  stepTextDone: {
    color: theme?.colors?.textSubtle,
    textDecorationLine: "line-through",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.xs,
    alignSelf: "stretch",
    backgroundColor: theme?.colors?.primary,
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: 13,
    marginTop: theme?.spacing?.xs,
    ...theme?.shadows?.light,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    ...theme?.typography?.bodyBold,
    color: "#fff",
  },
  dismissBtn: {
    paddingVertical: theme?.spacing?.s,
    alignItems: "center",
  },
  dismissText: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
  },
});
