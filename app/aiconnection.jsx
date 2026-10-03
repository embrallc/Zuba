import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import {
  buildConnectionInstructions,
  createAiConnection,
  disableAiConnection,
  getAiConnectionStatus,
} from "../utils/aiConnection";
import { isOnline } from "../utils/connectivity";

// "Integrate your favorite AI". Any user (not just owners) can create ONE
// connection key that lets an AI assistant — Muse, ChatGPT, Claude, a skill or
// script — use Zanbi's MCP tools as them, and only them.
//
// The key is shown exactly once, right after it's created: the server keeps
// only a hash. So the copied instructions live in this screen's memory until
// the user leaves, and are never saved. Lost them? Disable, then create again.
//
// Copying uses react-native's built-in Clipboard (deprecated but still shipped
// in RN 0.81) so this needs no new native module or rebuild. Swap to
// expo-clipboard with the next native batch.
export default function AiConnectionScreen() {
  const router = useRouter();

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  // Only set right after creating a key; never persisted.
  const [instructions, setInstructions] = useState(null);
  const [newKey, setNewKey] = useState(null);
  // What's on the clipboard from us: "instructions" | "key" | null.
  const [copiedWhat, setCopiedWhat] = useState(null);

  const reload = useCallback(async () => {
    // Connection state lives only in the cloud; offline we can't know it.
    if (!isOnline()) {
      setOffline(true);
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const s = await getAiConnectionStatus();
      setStatus(s);
      setOffline(false);
    } catch (e) {
      logError(e, "AiConnection.reload");
      setOffline(true);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function copy(text, what) {
    try {
      Clipboard.setString(text);
      setCopiedWhat(what);
      return true;
    } catch (e) {
      logError(e, "AiConnection.copy");
      setCopiedWhat(null);
      Alert.alert(
        "Couldn't copy",
        "Select the instructions on this screen and copy them by hand.",
      );
      return false;
    }
  }

  async function handleCreate() {
    if (busy) return;
    setBusy(true);
    try {
      const key = await createAiConnection();
      const text = buildConnectionInstructions(key);
      setNewKey(key);
      setInstructions(text);
      copy(text, "instructions");
      await reload();
    } catch (e) {
      logError(e, "AiConnection.handleCreate");
      // Another device may have created one — show the real state.
      if (e?.code === "already_connected") await reload();
      Alert.alert("Couldn't connect", e?.message || "Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  function handleDisable() {
    Alert.alert(
      "Disable your AI connection?",
      "Every AI app using this connection will lose access right away. You can create a new one any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disable",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await disableAiConnection();
              setInstructions(null);
              setNewKey(null);
              setCopiedWhat(null);
              await reload();
            } catch (e) {
              logError(e, "AiConnection.handleDisable");
              Alert.alert("Couldn't disable", e?.message || "Please try again in a moment.");
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  const connected = !!status?.connected;

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
        <Text style={styles.navTitle} numberOfLines={1}>
          Integrate your favorite AI
        </Text>
        <View style={{ width: theme?.layout?.iconSize?.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator
            size="large"
            color={theme?.colors?.primary}
            style={{ marginTop: theme?.spacing?.xl }}
          />
        ) : offline ? (
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <MaterialCommunityIcons
                name="wifi-off"
                size={20}
                color={theme?.colors?.textFine}
              />
              <Text style={styles.cardTitle}>Can't load this setting</Text>
            </View>
            <Text style={styles.cardBody}>
              You're offline. Connect to the internet and try again.
            </Text>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={reload}
              activeOpacity={0.85}
            >
              <Text style={styles.btnPrimaryTxt}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Just created: the one and only time the key exists on the phone. */}
            {instructions ? (
              <View style={styles.card}>
                <View style={styles.statusRow}>
                  <MaterialCommunityIcons
                    name="check-circle"
                    size={22}
                    color={theme?.colors?.success}
                  />
                  <Text style={styles.cardTitle}>
                    {copiedWhat === "key"
                      ? "Key copied, now paste it into your AI app"
                      : copiedWhat === "instructions"
                        ? "Copied, now add it to your AI app"
                        : "Add this to your AI app"}
                  </Text>
                </View>
                <Text style={styles.cardBody}>
                  Add this in your AI app's connector or MCP server settings, or give it
                  to the skill that calls Zanbi. Some assistants (like Muse) ask for just
                  the key to keep in secure storage. Use "Copy key only" for those. Treat
                  the key like a password. It's shown only once; if you lose it, disable
                  the connection and create a new one.
                </Text>
                <View style={styles.codeBox}>
                  <Text selectable style={styles.code}>
                    {instructions}
                  </Text>
                </View>
                <View style={styles.btnRow}>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnSecondary, styles.btnHalf]}
                    onPress={() => copy(instructions, "instructions")}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.btnSecondaryTxt}>Copy instructions</Text>
                  </TouchableOpacity>
                  {newKey ? (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnSecondary, styles.btnHalf]}
                      onPress={() => copy(newKey, "key")}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.btnSecondaryTxt}>Copy key only</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ) : null}

            {connected ? (
              <View style={styles.card}>
                <View style={styles.statusRow}>
                  <MaterialCommunityIcons
                    name="robot"
                    size={22}
                    color={theme?.colors?.success}
                  />
                  <Text style={styles.cardTitle}>Your AI connection is on</Text>
                </View>
                <Text style={styles.acctId}>
                  {status?.keyPrefix}… · Created {formatDay(status?.createdAt)} ·{" "}
                  {status?.lastUsedAt
                    ? `Last used ${formatWhen(status.lastUsedAt)}`
                    : "Not used yet"}
                </Text>
                {!instructions ? (
                  <Text style={styles.cardBody}>
                    Need the instructions again? For your security a key is only shown
                    once — disable this connection and create a new one.
                  </Text>
                ) : null}
              </View>
            ) : (
              <View style={styles.card}>
                <View style={styles.statusRow}>
                  <MaterialCommunityIcons
                    name="robot-outline"
                    size={22}
                    color={theme?.colors?.primary}
                  />
                  <Text style={styles.cardTitle}>Connect your AI assistant</Text>
                </View>
                <Text style={styles.cardBody}>
                  Let an AI assistant like Muse, ChatGPT or Claude answer questions about
                  your inspections ("what's on my schedule tomorrow?"). Works with any
                  assistant that lets you add an MCP server with a key, on your phone or
                  your computer.
                </Text>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
                  onPress={handleCreate}
                  disabled={busy}
                  activeOpacity={0.85}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnPrimaryTxt}>
                      Tap to copy connection instructions for your AI
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* What the AI can and can't reach — stated in every state on purpose.
                Keep in sync with the tools registered in supabase/functions/mcp
                (update this copy when a tool that changes data is added). */}
            <View style={[styles.card, styles.noteCard]}>
              <View style={styles.statusRow}>
                <MaterialCommunityIcons
                  name="shield-check-outline"
                  size={18}
                  color={theme?.colors?.textFine}
                />
                <Text style={styles.cardTitle}>What your AI can see</Text>
              </View>
              <Text style={styles.cardBody}>
                Only what Zanbi's AI tools allow — today, looking up your inspections for
                a day. It sees only inspections assigned to you, never the rest of your
                organization's, and it can't change anything in your account.
              </Text>
            </View>

            {connected ? (
              <TouchableOpacity
                style={styles.dangerLink}
                onPress={handleDisable}
                disabled={busy}
                activeOpacity={0.7}
              >
                <Text style={styles.dangerTxt}>Disable my AI Connection</Text>
              </TouchableOpacity>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatDay(iso) {
  if (!iso) return "recently";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "recently";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (_) {
    return "recently";
  }
}

function formatWhen(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "recently";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (_) {
    return "recently";
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme?.colors?.mainBackground },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    borderBottomWidth: theme?.layout?.borderWidth?.thin,
    borderBottomColor: theme?.colors?.input,
    ...theme?.shadows?.light,
  },
  navTitle: { ...theme?.typography?.h4, flexShrink: 1, textAlign: "center" },
  content: { padding: theme?.spacing?.m, paddingBottom: theme?.spacing?.xxl },
  card: {
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.m,
    padding: theme?.spacing?.m,
    marginBottom: theme?.spacing?.m,
    ...theme?.shadows?.light,
  },
  noteCard: { backgroundColor: theme?.colors?.input },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.s,
    marginBottom: theme?.spacing?.s,
  },
  cardTitle: { ...theme?.typography?.bodyBold, flexShrink: 1 },
  cardBody: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    marginTop: 2,
    lineHeight: 19,
  },
  acctId: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginBottom: theme?.spacing?.s,
  },
  codeBox: {
    backgroundColor: theme?.colors?.input,
    borderRadius: theme?.layout?.borderRadius?.m,
    padding: theme?.spacing?.m,
    marginTop: theme?.spacing?.m,
  },
  code: {
    ...theme?.typography?.caption,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    color: theme?.colors?.text,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: theme?.spacing?.m,
    paddingHorizontal: theme?.spacing?.m,
    marginTop: theme?.spacing?.m,
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: theme?.colors?.primary, ...theme?.shadows?.medium },
  btnPrimaryTxt: { ...theme?.typography?.bodyBold, color: "#fff", textAlign: "center" },
  btnSecondary: {
    backgroundColor: theme?.colors?.cardBackground,
    borderWidth: theme?.layout?.borderWidth?.thin,
    borderColor: theme?.colors?.primary,
  },
  btnSecondaryTxt: { ...theme?.typography?.bodyBold, color: theme?.colors?.primary },
  btnRow: { flexDirection: "row", gap: theme?.spacing?.s },
  btnHalf: { flex: 1 },
  btnDisabled: { opacity: theme?.layout?.opacity?.disabled },
  dangerLink: { alignItems: "center", paddingVertical: theme?.spacing?.m },
  dangerTxt: {
    ...theme?.typography?.label,
    color: theme?.colors?.error,
    fontWeight: "600",
  },
});
