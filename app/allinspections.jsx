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
import {
  deleteInspectionLocal,
  getAllInspections,
} from "../db/inspections";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
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

export default function AllInspectionsScreen() {
  const router = useRouter();
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userSk = useSettingsStore((s) => s.userSk);
  const userProfile = useSettingsStore((s) => s.userProfile);
  const loadInspections = useInspectionStore((s) => s.load);

  const [loading, setLoading] = useState(true);
  const [inspections, setInspections] = useState([]);
  const [orgUsers, setOrgUsers] = useState([]);
  // Map of inspection_sk → chosen user_id. Only the rows whose value differs
  // from the inspection's original user_id are submitted on Save.
  const [assignments, setAssignments] = useState({});
  const [pickingFor, setPickingFor] = useState(null);
  const [saving, setSaving] = useState(false);

  const canManage = userProfile === "owner" || userProfile === "admin";

  const load = useCallback(async () => {
    if (!canManage || !orgSk) {
      setLoading(false);
      return;
    }
    try {
      const [{ data: inspectionRows, error: inspErr }, { data: userRows, error: userErr }] =
        await Promise.all([
          supabase.rpc("list_all_org_inspections"),
          supabase
            .from("users")
            .select("id, fname, lname, user_profile")
            .eq("org_sk", orgSk),
        ]);
      if (inspErr) throw inspErr;
      if (userErr) throw userErr;
      setInspections(inspectionRows ?? []);
      const sorted = (userRows ?? []).sort((a, b) =>
        fullName(a).localeCompare(fullName(b)),
      );
      setOrgUsers(sorted);
    } catch (e) {
      logError(e, "AllInspectionsScreen.load");
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

  const inspectionsBySk = useMemo(() => {
    const map = {};
    for (const i of inspections) map[i.inspection_sk] = i;
    return map;
  }, [inspections]);

  // Only count assignments that actually differ from the inspection's current
  // user_id — tapping the picker, picking the same person, and tapping Save
  // shouldn't trigger a reassign.
  const pendingPayload = useMemo(() => {
    const out = [];
    for (const [sk, uid] of Object.entries(assignments)) {
      if (!uid) continue;
      const original = inspectionsBySk[sk]?.user_id ?? null;
      if (uid !== original) out.push({ inspection_sk: sk, new_user_id: uid });
    }
    return out;
  }, [assignments, inspectionsBySk]);

  function handlePick(inspectionSk, userId) {
    setAssignments((prev) => {
      const next = { ...prev };
      const original = inspectionsBySk[inspectionSk]?.user_id ?? null;
      if (userId === original) {
        // Picking the current assignee back is a no-op — drop the pending row.
        delete next[inspectionSk];
      } else {
        next[inspectionSk] = userId;
      }
      return next;
    });
    setPickingFor(null);
  }

  async function handleSave() {
    if (saving || pendingPayload.length === 0) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "reassign-inspection",
        { body: { assignments: pendingPayload } },
      );
      if (error) {
        let detail = error.message ?? "Could not save.";
        try {
          const body = await error.context?.json?.();
          if (body?.error) detail = body.error;
        } catch (_) {}
        logError(error, `AllInspectionsScreen.handleSave detail="${detail}"`);
        Alert.alert("Save failed", detail);
        return;
      }
      const results = data?.results ?? [];
      const failures = results.filter((r) => !r.ok);
      if (failures.length > 0) {
        Alert.alert(
          "Some reassignments failed",
          failures.map((f) => `• ${f.inspection_sk}: ${f.error}`).join("\n"),
        );
      }

      // For every reassign that succeeded AND moved the inspection away from
      // the current user, wipe it from local SQLite + the inspection store
      // right now. We don't rely on the next syncAll's prune phase here —
      // any unsynced local edit on the row would otherwise be pushed first
      // and overwrite the cloud reassign with our stale user_id.
      const successfulSet = new Set(
        results.filter((r) => r.ok).map((r) => r.inspection_sk),
      );
      const store = useInspectionStore.getState();
      for (const p of pendingPayload) {
        if (
          successfulSet.has(p.inspection_sk) &&
          p.new_user_id !== userSk
        ) {
          try {
            await deleteInspectionLocal(p.inspection_sk);
            store.remove(p.inspection_sk);
          } catch (e) {
            logError(
              e,
              `AllInspectionsScreen.handleSave.localCleanup sk=${p.inspection_sk}`,
            );
          }
        }
      }

      setAssignments({});
      await load();
      // Background sync keeps everything else consistent (e.g. inspections
      // reassigned *to* me show up locally) but is no longer load-bearing
      // for the reassign-away case.
      syncAll()
        .then(async () => loadInspections((await getAllInspections()) ?? []))
        .catch((e) => logError(e, "AllInspectionsScreen.handleSave.sync"));
    } catch (e) {
      logError(e, "AllInspectionsScreen.handleSave");
      Alert.alert("Save failed", "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function renderRow({ item }) {
    const chosenId = assignments[item.inspection_sk] ?? item.user_id;
    const chosenUser = chosenId ? usersById[chosenId] : null;
    const isChanged =
      assignments[item.inspection_sk] != null &&
      assignments[item.inspection_sk] !== item.user_id;
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
          <Text style={styles.assignLabel}>Assigned to</Text>
          <View style={styles.assignValueWrap}>
            <Text
              style={[
                styles.assignValue,
                !chosenUser && styles.assignValuePlaceholder,
                isChanged && styles.assignValueChanged,
              ]}
              numberOfLines={1}
            >
              {chosenUser ? fullName(chosenUser) : "Unassigned"}
            </Text>
            <MaterialCommunityIcons
              name="chevron-down"
              size={18}
              color={isChanged ? theme.colors.warning : theme.colors.textSubtle}
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
        <Text style={styles.navTitle}>All Inspections</Text>
        <TouchableOpacity
          onPress={handleSave}
          hitSlop={theme.layout.hitSlop.medium}
          disabled={saving || pendingPayload.length === 0}
          style={[
            styles.saveBtn,
            (saving || pendingPayload.length === 0) && styles.saveBtnDisabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <MaterialCommunityIcons
              name="check"
              size={22}
              color={
                pendingPayload.length === 0
                  ? theme.colors.textSubtle
                  : theme.colors.primary
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
            Only owners and admins can view all inspections.
          </Text>
        </View>
      ) : inspections.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="clipboard-text-outline"
            size={48}
            color={theme.colors.textFine}
          />
          <Text style={styles.emptyText}>No inspections yet.</Text>
        </View>
      ) : (
        <FlatList
          data={inspections}
          keyExtractor={(item) => item.inspection_sk}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
        />
      )}

      <UserPickerModal
        visible={!!pickingFor}
        users={orgUsers}
        selectedId={pickingFor ? assignments[pickingFor] ?? inspectionsBySk[pickingFor]?.user_id : null}
        onClose={() => setPickingFor(null)}
        onSelect={(userId) => handlePick(pickingFor, userId)}
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
  assignValueChanged: {
    color: theme.colors.warning,
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
