import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  deleteSectionTemplate,
  getSectionTemplates,
  insertSectionTemplate,
  reorderSectionTemplates,
  updateSectionTemplateName,
} from "../db/sectionTemplates";
import { logError } from "../db/logs";
import { useSettingsStore } from "../stores/useSettingsStore";

export default function SectionTemplatesScreen() {
  const router = useRouter();
  const userSk = useSettingsStore((s) => s.userSk);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const saveTimers = useRef({});

  // Stable refs so renderItem useCallback stays stable
  const handleNameChangeRef = useRef(null);
  const handleDeleteRef = useRef(null);

  const load = useCallback(async () => {
    if (!userSk) return;
    try {
      const rows = await getSectionTemplates(userSk);
      setTemplates(
        rows.map((r) => ({
          sk: r.SectionTemplateSk,
          name: r.Name,
          position: r.Position,
        })),
      );
    } catch (e) {
      logError(e, "SectionTemplatesScreen.load");
    } finally {
      setLoading(false);
    }
  }, [userSk]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    if (!userSk) return;
    try {
      const position = templates.length;
      const row = await insertSectionTemplate(userSk, "", position);
      setTemplates((prev) => [
        ...prev,
        { sk: row.SectionTemplateSk, name: "", position },
      ]);
    } catch (e) {
      logError(e, "SectionTemplatesScreen.handleAdd");
    }
  }

  function handleNameChange(sk, value) {
    setTemplates((prev) =>
      prev.map((t) => (t.sk === sk ? { ...t, name: value } : t)),
    );
    clearTimeout(saveTimers.current[sk]);
    saveTimers.current[sk] = setTimeout(async () => {
      try {
        await updateSectionTemplateName(sk, value);
      } catch (e) {
        logError(e, `SectionTemplatesScreen.handleNameChange sk=${sk}`);
      }
    }, 600);
  }
  handleNameChangeRef.current = handleNameChange;

  async function handleDelete(sk) {
    try {
      await deleteSectionTemplate(sk);
      setTemplates((prev) => {
        const updated = prev
          .filter((t) => t.sk !== sk)
          .map((t, i) => ({ ...t, position: i }));
        reorderSectionTemplates(
          updated.map((t) => ({ sk: t.sk, position: t.position })),
        ).catch((e) => logError(e, "SectionTemplatesScreen.handleDelete reorder"));
        return updated;
      });
    } catch (e) {
      logError(e, `SectionTemplatesScreen.handleDelete sk=${sk}`);
    }
  }
  handleDeleteRef.current = handleDelete;

  async function handleDragEnd({ data }) {
    const reordered = data.map((item, i) => ({ ...item, position: i }));
    setTemplates(reordered);
    try {
      await reorderSectionTemplates(
        reordered.map((t) => ({ sk: t.sk, position: t.position })),
      );
    } catch (e) {
      logError(e, "SectionTemplatesScreen.handleDragEnd");
    }
  }

  const renderItem = useCallback(({ item, drag, isActive }) => {
    return (
      <ScaleDecorator activeScale={0.97}>
        <View style={[styles.row, isActive && styles.rowActive]}>
          <TouchableOpacity
            onLongPress={drag}
            delayLongPress={150}
            style={styles.dragHandle}
            hitSlop={theme.layout.hitSlop.medium}
          >
            <MaterialCommunityIcons
              name="drag-horizontal-variant"
              size={22}
              color={theme.colors.textFine}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.nameInput}
            value={item.name}
            onChangeText={(v) => handleNameChangeRef.current(item.sk, v)}
            placeholder="Section name…"
            placeholderTextColor={theme.colors.textFine}
            returnKeyType="done"
          />
          <TouchableOpacity
            onPress={() => handleDeleteRef.current(item.sk)}
            hitSlop={theme.layout.hitSlop.medium}
            style={styles.deleteBtn}
          >
            <MaterialCommunityIcons
              name="trash-can-outline"
              size={theme.layout.iconSize.m}
              color={theme.colors.textSubtle}
            />
          </TouchableOpacity>
        </View>
      </ScaleDecorator>
    );
  }, []);

  const listHeader = (
    <View style={styles.hint}>
      <MaterialCommunityIcons
        name="information-outline"
        size={14}
        color={theme.colors.textFine}
      />
      <Text style={styles.hintText}>
        These sections auto-fill when you open a blank inspection form.
        Long-press the handle to reorder.
      </Text>
    </View>
  );

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
        <Text style={styles.navTitle}>Form Sections</Text>
        <TouchableOpacity
          onPress={handleAdd}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="plus"
            size={theme.layout.iconSize.l}
            color={theme.colors.primary}
          />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator
          style={{ flex: 1 }}
          size="large"
          color={theme.colors.primary}
        />
      ) : templates.length === 0 ? (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons
            name="format-list-bulleted-square"
            size={52}
            color={theme.colors.textFine}
          />
          <Text style={styles.emptyTitle}>No sections yet</Text>
          <Text style={styles.emptyBody}>
            Tap the + button to add section names. They'll auto-populate when
            you start a new blank inspection.
          </Text>
        </View>
      ) : (
        <DraggableFlatList
          data={templates}
          keyExtractor={(item) => item.sk}
          onDragEnd={handleDragEnd}
          renderItem={renderItem}
          ListHeaderComponent={listHeader}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        />
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

  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.xs,
    marginHorizontal: theme.spacing.m,
    marginTop: theme.spacing.m,
    marginBottom: theme.spacing.s,
  },
  hintText: {
    ...theme.typography.label,
    color: theme.colors.textFine,
    flex: 1,
    lineHeight: 18,
  },

  listContent: {
    paddingBottom: theme.spacing.xxl,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.cardBackground,
    marginHorizontal: theme.spacing.m,
    marginBottom: theme.spacing.s,
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: theme.spacing.s,
    paddingRight: theme.spacing.m,
    ...theme.shadows.light,
  },
  rowActive: {
    ...theme.shadows.dark,
    opacity: 0.96,
  },
  dragHandle: {
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
  },
  nameInput: {
    flex: 1,
    ...theme.typography.body,
    color: theme.colors.text,
    paddingVertical: theme.spacing.xs,
  },
  deleteBtn: {
    paddingLeft: theme.spacing.s,
  },

  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.xl,
    gap: theme.spacing.m,
  },
  emptyTitle: {
    ...theme.typography.h4,
    color: theme.colors.textSubtle,
  },
  emptyBody: {
    ...theme.typography.body,
    color: theme.colors.textFine,
    textAlign: "center",
    lineHeight: 22,
  },
});
