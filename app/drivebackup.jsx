import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { markDrivePromptSeen } from "../db/organizations";
import { useSettingsStore } from "../stores/useSettingsStore";
import { isOnline } from "../utils/connectivity";
import {
  disconnectDrive,
  getDriveStatus,
  retryFailedBackups,
  setDriveBackupEnabled,
  startDriveConnect,
} from "../utils/drive";

// Owner-only Google Drive backup settings. Connecting is a hosted Google flow
// (system browser, not an embedded webview — Google blocks OAuth in webviews);
// everything after that is automatic, so this screen is mostly a status surface:
// who's connected, when the last backup ran, and what needs attention.
//
// Backups are FORWARD-ONLY. The copy says so plainly in every state, because an
// inspector who assumes their history came along would be badly surprised.
export default function DriveBackupScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userProfile = useSettingsStore((s) => s.userProfile);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const reload = useCallback(async () => {
    // Connection state lives only in the cloud; offline we can't know it, and
    // rendering "not connected" would be a lie that invites a pointless retry.
    if (!isOnline()) {
      setOffline(true);
      setStatus(null);
      setLoading(false);
      return null;
    }
    try {
      const s = await getDriveStatus();
      setStatus(s);
      setOffline(false);
      return s;
    } catch (e) {
      logError(e, "DriveBackup.reload");
      setOffline(true);
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await startDriveConnect();
      await reload();
      // Reaching this screen at all means they've engaged with the prompt, so
      // retire it either way — the entry point lives here from now on.
      if (orgSk) markDrivePromptSeen(orgSk).catch(() => {});
      if (!res.ok && !res.dismissed && res.message) {
        Alert.alert("Not connected", res.message);
      }
    } catch (e) {
      logError(e, "DriveBackup.handleConnect");
      Alert.alert(
        "Couldn't start setup",
        e?.message || "We couldn't open the Google sign-in page. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function handleDisconnect() {
    Alert.alert(
      "Disconnect Google Drive?",
      "New inspections will stop backing up. Everything already in your Drive stays there — nothing is deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await disconnectDrive();
              await reload();
            } catch (e) {
              logError(e, "DriveBackup.handleDisconnect");
              Alert.alert(
                "Couldn't disconnect",
                e?.message || "Please try again in a moment.",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await retryFailedBackups();
      await reload();
      Alert.alert(
        "Retrying",
        res?.retried
          ? `Re-queued ${res.retried} inspection${res.retried === 1 ? "" : "s"}. This can take a few minutes.`
          : "There's nothing waiting to retry.",
      );
    } catch (e) {
      logError(e, "DriveBackup.handleRetry");
      Alert.alert("Couldn't retry", e?.message || "Please try again in a moment.");
    } finally {
      setRetrying(false);
    }
  }

  async function handleToggleEnabled(next) {
    const prev = status;
    setStatus((s) => ({ ...s, backupEnabled: next }));
    try {
      await setDriveBackupEnabled(next);
    } catch (e) {
      logError(e, "DriveBackup.handleToggleEnabled");
      setStatus(prev);
      Alert.alert("Couldn't save", "That setting didn't save. Please try again.");
    }
  }

  const connected = !!status?.connected;
  const needsReconnect = status?.status === "revoked" || status?.status === "error";

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
        <Text style={styles.navTitle}>Google Drive Backup</Text>
        <View style={{ width: theme?.layout?.iconSize?.l }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {userProfile !== "owner" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Owner only</Text>
            <Text style={styles.cardBody}>
              Only the organization owner can connect a Google Drive for backups.
            </Text>
          </View>
        ) : loading ? (
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
              <Text style={styles.cardTitle}>Can't load these settings</Text>
            </View>
            <Text style={styles.cardBody}>
              You're offline. Connect to the internet and pull down to try again.
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
            {/* Status */}
            <View style={styles.card}>
              <View style={styles.statusRow}>
                <MaterialCommunityIcons
                  name={
                    connected
                      ? "cloud-check"
                      : needsReconnect
                        ? "cloud-alert"
                        : "cloud-upload-outline"
                  }
                  size={22}
                  color={
                    connected
                      ? theme?.colors?.success
                      : needsReconnect
                        ? theme?.colors?.warning
                        : theme?.colors?.primary
                  }
                />
                <Text style={styles.cardTitle}>
                  {connected
                    ? "Backup is on"
                    : needsReconnect
                      ? "Reconnect Google Drive"
                      : "Back up to your Google Drive"}
                </Text>
              </View>

              <Text style={styles.cardBody}>
                {connected
                  ? "Every inspection you complete is copied to your Google Drive — the report PDF, all photos, and a data file with the full record."
                  : needsReconnect
                    ? status?.lastError ||
                      "Zanbi's access to your Google Drive ended. Reconnect to start backing up again."
                    : "Keep your own copy of every completed inspection for your records. You'll sign in with Google and approve access — Zanbi can only ever see the files it creates, never the rest of your Drive."}
              </Text>

              {connected && status?.googleEmail ? (
                <Text style={styles.acctId}>Connected as {status.googleEmail}</Text>
              ) : null}

              {connected ? (
                <>
                  <Text style={styles.acctId}>
                    Last backup: {formatWhen(status?.lastBackupAt)}
                  </Text>
                  {status?.lastError ? (
                    <Text style={styles.warnText}>{status.lastError}</Text>
                  ) : null}
                </>
              ) : null}

              {!connected && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
                  onPress={handleConnect}
                  disabled={busy}
                  activeOpacity={0.85}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnPrimaryTxt}>
                      {needsReconnect ? "Reconnect Google Drive" : "Connect Google Drive"}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Forward-only warning — stated in BOTH states on purpose. */}
            <View style={[styles.card, styles.noteCard]}>
              <View style={styles.statusRow}>
                <MaterialCommunityIcons
                  name="information-outline"
                  size={18}
                  color={theme?.colors?.textFine}
                />
                <Text style={styles.cardTitle}>
                  {connected ? "What's covered" : "Start now, not later"}
                </Text>
              </View>
              <Text style={styles.cardBody}>
                {connected
                  ? "Backups cover inspections completed after you connected. Anything finished before that isn't in your Drive — contact support if you need an older record."
                  : "Backups only cover inspections you complete after connecting. Anything already finished won't be copied, and recovering it later means a support request — so it's worth connecting today."}
              </Text>
            </View>

            {connected && (
              <>
                <View style={styles.card}>
                  <View style={styles.toggleRow}>
                    <View style={styles.rowText}>
                      <Text style={styles.rowLabel}>Back up completed inspections</Text>
                      <Text style={styles.rowDescription}>
                        Turn off to pause backups without disconnecting your Drive.
                      </Text>
                    </View>
                    <Switch
                      value={status?.backupEnabled !== false}
                      onValueChange={handleToggleEnabled}
                      trackColor={{
                        false: theme?.colors?.input,
                        true: theme?.colors?.primary,
                      }}
                    />
                  </View>
                </View>

                <Text style={styles.sectionLabel}>ACTIVITY</Text>

                <View style={styles.card}>
                  <View style={styles.countsRow}>
                    <Count label="Backed up" value={status?.counts?.done ?? 0} />
                    <Count label="In progress" value={status?.counts?.pending ?? 0} />
                    <Count
                      label="Needs attention"
                      value={status?.counts?.failed ?? 0}
                      warn={(status?.counts?.failed ?? 0) > 0}
                    />
                  </View>

                  {(status?.counts?.failed ?? 0) > 0 && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnPrimary, retrying && styles.btnDisabled]}
                      onPress={handleRetry}
                      disabled={retrying}
                      activeOpacity={0.85}
                    >
                      {retrying ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.btnPrimaryTxt}>Retry failed backups</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>

                {(status?.recent ?? []).length > 0 && (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Recent</Text>
                    {(status?.recent ?? []).map((r) => (
                      <RecentRow key={r.inspectionSk} row={r} />
                    ))}
                  </View>
                )}

                <TouchableOpacity
                  style={styles.dangerLink}
                  onPress={handleDisconnect}
                  disabled={busy}
                  activeOpacity={0.7}
                >
                  <Text style={styles.dangerTxt}>Disconnect Google Drive</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Count({ label, value, warn }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.countValue, warn && styles.countValueWarn]}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function RecentRow({ row }) {
  const done = row?.status === "done";
  const failed = row?.status === "failed";
  return (
    <View style={styles.recentRow}>
      <MaterialCommunityIcons
        name={done ? "check-circle" : failed ? "alert-circle-outline" : "progress-clock"}
        size={16}
        color={
          done
            ? theme?.colors?.success
            : failed
              ? theme?.colors?.warning
              : theme?.colors?.textFine
        }
      />
      <View style={styles.rowText}>
        <Text style={styles.recentLabel} numberOfLines={1}>
          {row?.label ?? "Inspection"}
        </Text>
        <Text style={styles.recentMeta}>
          {failed
            ? (row?.lastError ?? "Backup failed")
            : done
              ? formatWhen(row?.syncedAt ?? row?.updatedAt)
              : `Backing up ${row?.filesDone ?? 0}/${row?.filesTotal ?? 0}`}
        </Text>
      </View>
    </View>
  );
}

function formatWhen(iso) {
  if (!iso) return "not yet";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "not yet";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (_) {
    return "not yet";
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
  navTitle: { ...theme?.typography?.h4 },
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
  warnText: {
    ...theme?.typography?.label,
    color: theme?.colors?.warning,
    marginTop: theme?.spacing?.s,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: theme?.spacing?.m,
    marginTop: theme?.spacing?.m,
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: theme?.colors?.primary, ...theme?.shadows?.medium },
  btnPrimaryTxt: { ...theme?.typography?.bodyBold, color: "#fff" },
  btnDisabled: { opacity: theme?.layout?.opacity?.disabled },
  acctId: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginTop: theme?.spacing?.s,
  },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  rowText: { flex: 1, marginRight: theme?.spacing?.m },
  rowLabel: { ...theme?.typography?.bodyBold },
  rowDescription: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    marginTop: 2,
    lineHeight: 18,
  },
  sectionLabel: {
    ...theme?.typography?.overline,
    marginTop: theme?.spacing?.s,
    marginBottom: theme?.spacing?.s,
  },
  countsRow: { flexDirection: "row", justifyContent: "space-between" },
  count: { alignItems: "center", flex: 1 },
  countValue: { ...theme?.typography?.h3, color: theme?.colors?.text },
  countValueWarn: { color: theme?.colors?.warning },
  countLabel: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginTop: 2,
    textAlign: "center",
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme?.spacing?.s,
    marginTop: theme?.spacing?.m,
  },
  recentLabel: { ...theme?.typography?.label, color: theme?.colors?.text },
  recentMeta: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    marginTop: 1,
  },
  dangerLink: { alignItems: "center", paddingVertical: theme?.spacing?.m },
  dangerTxt: {
    ...theme?.typography?.label,
    color: theme?.colors?.error,
    fontWeight: "600",
  },
});
