import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { getAllInspections } from "../db/inspections";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { isOnline } from "../utils/connectivity";
import { supabase } from "../utils/supabase";
import { syncAll } from "../utils/sync";

function fullName(u) {
  const name = `${u.fname ?? ""} ${u.lname ?? ""}`.trim();
  return name || "Unnamed user";
}

function formatScheduledAt(iso) {
  if (!iso) return "—";
  return dayjs(iso).format("MMM D, YYYY · h:mm A");
}

function formatAddress(insp) {
  return [
    insp.address_line1,
    insp.address_line2,
    insp.city,
    insp.state,
    insp.zip_code,
  ]
    .filter(Boolean)
    .join(", ");
}

export default function UnassignedRecordsScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userProfile = useSettingsStore((s) => s.userProfile);
  const loadInspections = useInspectionStore((s) => s.load);

  const [loading, setLoading] = useState(true);
  const [orphans, setOrphans] = useState([]);
  const [orgUsers, setOrgUsers] = useState([]);
  // Map of inspection_sk → chosen user_id (only set after user picks).
  const [assignments, setAssignments] = useState({});
  // Which inspection is currently picking a user (or null).
  const [pickingFor, setPickingFor] = useState(null);
  const [saving, setSaving] = useState(false);

  const canManage = userProfile === "owner" || userProfile === "admin";

  const load = useCallback(async () => {
    if (!canManage || !orgSk) {
      setLoading(false);
      return;
    }
    try {
      const [{ data: orphanRows, error: orphanErr }, { data: userRows, error: userErr }] =
        await Promise.all([
          supabase.rpc("list_unassigned_inspections"),
          supabase
            .from("users")
            .select("id, fname, lname, user_profile")
            .eq("org_sk", orgSk),
        ]);
      if (orphanErr) throw orphanErr;
      if (userErr) throw userErr;
      setOrphans(orphanRows ?? []);
      const sorted = (userRows ?? []).sort((a, b) =>
        fullName(a).localeCompare(fullName(b)),
      );
      setOrgUsers(sorted);
    } catch (e) {
      logError(e, "UnassignedRecordsScreen.load");
      Alert.alert("Couldn't load", e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [canManage, orgSk]);

  useEffect(() => {
    load();
  }, [load]);

  const usersById = useMemo(() => {
    const map = {};
    for (const u of orgUsers) map[u.id] = u;
    return map;
  }, [orgUsers]);

  const pendingCount = useMemo(
    () => Object.keys(assignments).filter((k) => !!assignments[k]).length,
    [assignments],
  );

  async function handleSave() {
    if (saving) return;
    const payload = Object.entries(assignments)
      .filter(([, uid]) => !!uid)
      .map(([inspection_sk, new_user_id]) => ({ inspection_sk, new_user_id }));
    if (payload.length === 0) return;
    if (!isOnline()) {
      Alert.alert(
        "You're offline",
        "Connect to the internet, then try saving again.",
      );
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "reassign-inspection",
        { body: { assignments: payload } },
      );
      if (error) {
        logError(error, "UnassignedRecordsScreen.handleSave.invoke");
        Alert.alert("Save failed", error.message ?? "Could not save.");
        return;
      }
      const results = data?.results ?? [];
      const failures = results.filter((r) => !r?.ok);
      if (failures.length > 0) {
        Alert.alert(
          "Some reassignments failed",
          failures
            .map(
              (f) =>
                `• ${f?.inspection_sk ?? "unknown"}: ${f?.error ?? "unknown error"}`,
            )
            .join("\n"),
        );
      }
      // Refresh the list (succeeded rows drop off) and sync local DB so the
      // newly-assigned inspections show up in calendar views.
      setAssignments({});
      await load();
      syncAll()
        .then(async () => loadInspections((await getAllInspections()) ?? []))
        .catch((e) => logError(e, "UnassignedRecordsScreen.handleSave.sync"));
    } catch (e) {
      logError(e, "UnassignedRecordsScreen.handleSave");
      Alert.alert("Save failed", "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function renderRow({ item }) {
    const chosenId = assignments[item.inspection_sk];
    const chosenUser = chosenId ? usersById[chosenId] : null;
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardName} numberOfLines={1}>
            {item.full_name || "Unnamed Inspection"}
          </Text>
          <Text style={styles.cardDate}>{formatScheduledAt(item.scheduled_at)}</Text>
        </View>
        <Text style={styles.cardAddress} numberOfLines={2}>
          {formatAddress(item) || "No address"}
        </Text>

        <View style={styles.divider} />

        <TouchableOpacity
          style={styles.assignRow}
          onPress={() => setPickingFor(item.inspection_sk)}
          activeOpacity={0.7}
        >
          <Text style={styles.assignLabel}>Assign to</Text>
          <View style={styles.assignValueWrap}>
            <Text
              style={[
                styles.assignValue,
                !chosenUser && styles.assignValuePlaceholder,
              ]}
              numberOfLines={1}
            >
              {chosenUser ? fullName(chosenUser) : "Choose user…"}
            </Text>
            <MaterialCommunityIcons
              name="chevron-down"
              size={18}
              color={theme.colors.textSubtle}
            />
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
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
        <Text style={styles.navTitle}>Unassigned Records</Text>
        <TouchableOpacity
          onPress={handleSave}
          hitSlop={theme.layout.hitSlop.medium}
          disabled={saving || pendingCount === 0}
          style={[
            styles.saveBtn,
            (saving || pendingCount === 0) && styles.saveBtnDisabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <MaterialCommunityIcons
              name="check"
              size={22}
              color={
                pendingCount === 0 ? theme.colors.textSubtle : theme.colors.primary
              }
            />
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : !canManage ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            Only owners and admins can view unassigned records.
          </Text>
        </View>
      ) : orphans.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="check-circle-outline"
            size={48}
            color={theme.colors.success}
          />
          <Text style={styles.emptyText}>No unassigned records.</Text>
        </View>
      ) : (
        <FlatList
          data={orphans}
          keyExtractor={(item) => item.inspection_sk}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
        />
      )}

      <UserPickerModal
        visible={!!pickingFor}
        users={orgUsers}
        selectedId={pickingFor ? assignments[pickingFor] : null}
        onClose={() => setPickingFor(null)}
        onSelect={(userId) => {
          setAssignments((prev) => ({ ...prev, [pickingFor]: userId }));
          setPickingFor(null);
        }}
      />
    </SafeAreaView>
  );
}

function UserPickerModal({ visible, users, selectedId, onClose, onSelect }) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Choose user</Text>
          <ScrollView style={styles.modalList}>
            {users.length === 0 ? (
              <Text style={styles.modalEmpty}>No other users in your org.</Text>
            ) : (
              users.map((u) => {
                const selected = u.id === selectedId;
                return (
                  <TouchableOpacity
                    key={u.id}
                    style={[styles.modalRow, selected && styles.modalRowSelected]}
                    onPress={() => onSelect(u.id)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowName}>{fullName(u)}</Text>
                      <Text style={styles.modalRowId} numberOfLines={1}>
                        {u.id}
                      </Text>
                    </View>
                    {selected && (
                      <MaterialCommunityIcons
                        name="check"
                        size={20}
                        color={theme.colors.primary}
                      />
                    )}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
    flex: 1,
    textAlign: "center",
    marginHorizontal: theme.spacing.m,
  },
  saveBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.l,
    gap: theme.spacing.m,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
  },
  list: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
  },
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.l,
    padding: theme.spacing.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing.s,
    marginBottom: theme.spacing.xs,
  },
  cardName: {
    ...theme.typography.bodyBold,
    flex: 1,
  },
  cardDate: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    flexShrink: 0,
  },
  cardAddress: {
    ...theme.typography.label,
    color: theme.colors.text,
  },
  divider: {
    height: theme.layout.borderWidth.thin,
    backgroundColor: theme.colors.input,
    marginVertical: theme.spacing.s,
  },
  assignRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.s,
  },
  assignLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  assignValueWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    maxWidth: "70%",
  },
  assignValue: {
    ...theme.typography.bodyBold,
    color: theme.colors.primary,
  },
  assignValuePlaceholder: {
    color: theme.colors.textSubtle,
    fontWeight: "400",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: theme.colors.cardBackground,
    borderTopLeftRadius: theme.layout.borderRadius.xl,
    borderTopRightRadius: theme.layout.borderRadius.xl,
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.s,
    paddingBottom: theme.spacing.xl,
    maxHeight: "70%",
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.input,
    alignSelf: "center",
    marginBottom: theme.spacing.m,
  },
  modalTitle: {
    ...theme.typography.h4,
    marginBottom: theme.spacing.s,
  },
  modalList: {
    maxHeight: 500,
  },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing.s,
    paddingHorizontal: theme.spacing.s,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.xs,
  },
  modalRowSelected: {
    backgroundColor: theme.colors.primaryGhost ?? "rgba(92,92,232,0.08)",
  },
  modalRowName: {
    ...theme.typography.bodyBold,
  },
  modalRowId: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    marginTop: 2,
  },
  modalEmpty: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    paddingVertical: theme.spacing.l,
  },
});
