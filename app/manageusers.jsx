import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { useSettingsStore } from "../stores/useSettingsStore";
import { supabase } from "../utils/supabase";

const ROLES = [
  { key: "owner", label: "Owner", color: theme.colors.primary },
  { key: "admin", label: "Admin", color: theme.colors.success },
  { key: "member", label: "Member", color: theme.colors.textSubtle },
];

function displayName(u) {
  const name = `${u.fname ?? ""} ${u.lname ?? ""}`.trim();
  return name || "Unnamed user";
}

export default function ManageUsersScreen() {
  const router = useRouter();
  const userSk = useSettingsStore((s) => s.userSk);
  const orgSk = useSettingsStore((s) => s.orgSk);
  const userProfile = useSettingsStore((s) => s.userProfile);
  const setUserProfile = useSettingsStore((s) => s.setUserProfile);

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  // Map of userId → true while their role is being updated. Disables their
  // pills + shows a spinner on the row.
  const [updating, setUpdating] = useState({});

  const canManage = userProfile === "owner";

  const load = useCallback(async () => {
    if (!orgSk) {
      setLoading(false);
      return;
    }
    try {
      const { data, error } = await supabase
        .from("users")
        .select("id, fname, lname, user_profile, org_sk")
        .eq("org_sk", orgSk);
      if (error) throw error;
      // Sort: owners first, then admins, then members, then alpha by name.
      const sortKey = (u) =>
        u.user_profile === "owner" ? 0 : u.user_profile === "admin" ? 1 : 2;
      const sorted = (data ?? []).sort((a, b) => {
        const k = sortKey(a) - sortKey(b);
        if (k !== 0) return k;
        return displayName(a).localeCompare(displayName(b));
      });
      setUsers(sorted);
    } catch (e) {
      logError(e, "ManageUsersScreen.load");
      Alert.alert("Couldn't load team", e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [orgSk]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeRole(targetUser, newRole) {
    if (!canManage) return;
    if (targetUser.user_profile === newRole) return;
    if (updating[targetUser.id]) return;

    // Optimistic update locally; server is the source of truth and will
    // reject (via trigger) if the change isn't allowed.
    const prev = users;
    setUpdating((m) => ({ ...m, [targetUser.id]: true }));
    setUsers((list) =>
      list.map((u) =>
        u.id === targetUser.id ? { ...u, user_profile: newRole } : u,
      ),
    );

    try {
      const { error } = await supabase
        .from("users")
        .update({ user_profile: newRole })
        .eq("id", targetUser.id);
      if (error) throw error;

      // If the owner just changed their own role, reflect it in the store so
      // gating updates immediately (the next session refresh picks up the new
      // metadata too, set by the role-change trigger on the server).
      if (targetUser.id === userSk) setUserProfile(newRole);
    } catch (e) {
      logError(e, `ManageUsersScreen.changeRole target=${targetUser.id}`);
      setUsers(prev);
      Alert.alert(
        "Couldn't update role",
        e?.message ?? "The server rejected this change.",
      );
    } finally {
      setUpdating((m) => {
        const next = { ...m };
        delete next[targetUser.id];
        return next;
      });
    }
  }

  async function deleteUser(target) {
    if (!canManage || target.id === userSk) return;
    if (updating[target.id]) return;
    Alert.alert(
      "Delete user?",
      `Permanently delete ${displayName(target)}'s account. Their inspections and photos will move to Unassigned Records so you can reassign them. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setUpdating((m) => ({ ...m, [target.id]: true }));
            try {
              const { data, error } = await supabase.functions.invoke(
                "delete-user",
                { body: { target_user_id: target.id } },
              );
              if (error) {
                let detail = error.message ?? "Could not delete user.";
                try {
                  const body = await error.context?.json?.();
                  if (body?.error) detail = body.error;
                } catch (_) {}
                logError(
                  error,
                  `ManageUsersScreen.deleteUser target=${target.id} detail="${detail}"`,
                );
                Alert.alert("Delete failed", detail);
                return;
              }
              if (data?.status !== "user_deleted") {
                Alert.alert(
                  "Delete failed",
                  data?.error ?? "Unexpected server response.",
                );
                return;
              }
              setUsers((list) => list.filter((u) => u.id !== target.id));
            } catch (e) {
              logError(e, `ManageUsersScreen.deleteUser target=${target.id}`);
              Alert.alert("Delete failed", "Could not delete user.");
            } finally {
              setUpdating((m) => {
                const next = { ...m };
                delete next[target.id];
                return next;
              });
            }
          },
        },
      ],
    );
  }

  function renderItem({ item }) {
    const isSelf = item.id === userSk;
    const busy = !!updating[item.id];
    const showDelete = canManage && !isSelf;
    return (
      <View style={styles.userRow}>
        <View style={styles.userHeader}>
          <View style={styles.userNameWrap}>
            <Text style={styles.userName} numberOfLines={1}>
              {displayName(item)}
            </Text>
            {isSelf && (
              <View style={styles.youBadge}>
                <Text style={styles.youBadgeText}>YOU</Text>
              </View>
            )}
          </View>
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : showDelete ? (
            <TouchableOpacity
              onPress={() => deleteUser(item)}
              hitSlop={theme.layout.hitSlop.medium}
              style={styles.deleteBtn}
            >
              <MaterialCommunityIcons
                name="trash-can-outline"
                size={20}
                color={theme.colors.error}
              />
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.roleRow}>
          {ROLES.map((r) => {
            const selected = item.user_profile === r.key;
            const disabled = !canManage || busy;
            return (
              <TouchableOpacity
                key={r.key}
                onPress={() => changeRole(item, r.key)}
                disabled={disabled}
                activeOpacity={0.75}
                style={[
                  styles.rolePill,
                  selected && {
                    backgroundColor: r.color,
                    borderColor: r.color,
                  },
                  disabled && !selected && styles.rolePillDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.rolePillText,
                    selected && styles.rolePillTextSelected,
                  ]}
                >
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
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
        <Text style={styles.navTitle}>Team</Text>
        <View style={{ width: theme.layout.iconSize.l }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.helpText}>
              {canManage
                ? "Tap a role to change a member's permission. Owners can manage roles; admins can view all org inspections; members see only their own."
                : "Only an owner can change roles."}
            </Text>
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <MaterialCommunityIcons
                name="account-group-outline"
                size={48}
                color={theme.colors.textFine}
              />
              <Text style={styles.emptyText}>
                You're the only member of this organization.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.mainBackground },
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
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing.xl,
    gap: theme.spacing.s,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
    textAlign: "center",
    paddingHorizontal: theme.spacing.xl,
  },
  list: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
  },
  helpText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    marginBottom: theme.spacing.m,
  },
  userRow: {
    backgroundColor: theme.colors.cardBackground,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.m,
    borderRadius: theme.layout.borderRadius.m,
    marginBottom: theme.spacing.s,
    ...theme.shadows.light,
  },
  userHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing.s,
  },
  userNameWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    flex: 1,
  },
  userName: {
    ...theme.typography.bodyBold,
    flexShrink: 1,
  },
  youBadge: {
    backgroundColor: theme.colors.primaryGhost,
    paddingHorizontal: theme.spacing.s,
    paddingVertical: 2,
    borderRadius: theme.layout.borderRadius.full,
  },
  youBadgeText: {
    ...theme.typography.caption,
    color: theme.colors.primary,
    fontWeight: "700",
    fontSize: 10,
    letterSpacing: 0.5,
  },
  deleteBtn: {
    padding: theme.spacing.xs,
  },
  roleRow: {
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  rolePill: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: theme.layout.borderRadius.full,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    backgroundColor: theme.colors.mainBackground,
    alignItems: "center",
  },
  rolePillDisabled: {
    opacity: 0.55,
  },
  rolePillText: {
    ...theme.typography.label,
    color: theme.colors.textSubtle,
    fontWeight: "600",
  },
  rolePillTextSelected: {
    color: "#fff",
    fontWeight: "700",
  },
});
