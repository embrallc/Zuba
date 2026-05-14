import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { useRouter } from "expo-router";
import { useRef } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  deleteSmsTemplate,
  insertSmsTemplate,
  updateSmsTemplate,
} from "../db/smsTemplates";
import { logError } from "../db/logs";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useSmsStore } from "../stores/useSmsStore";

const MAX_TEMPLATES = 5;

export default function SmsTemplatesScreen() {
  const router = useRouter();
  const userSk = useSettingsStore((s) => s.userSk);
  const templates = useSmsStore((s) => s.templates);
  const addTemplate = useSmsStore((s) => s.add);
  const updateTemplateStore = useSmsStore((s) => s.update);
  const removeTemplate = useSmsStore((s) => s.remove);
  const saveTimers = useRef({});

  async function handleAdd() {
    if (!userSk || templates.length >= MAX_TEMPLATES) return;
    try {
      const row = await insertSmsTemplate(userSk, "", "", templates.length);
      addTemplate(row);
    } catch (e) {
      logError(e, "SmsTemplatesScreen.handleAdd");
      Alert.alert("Error", "Could not save template. Please try again.");
    }
  }

  function handleNameChange(sk, value) {
    updateTemplateStore(sk, { Name: value });
    clearTimeout(saveTimers.current[`${sk}_name`]);
    saveTimers.current[`${sk}_name`] = setTimeout(async () => {
      try {
        const current = useSmsStore
          .getState()
          .templates.find((t) => t.SmsTemplateSk === sk);
        if (!current) return;
        await updateSmsTemplate(sk, current.Name, current.Body);
      } catch (e) {
        logError(e, `SmsTemplatesScreen.handleNameChange sk=${sk}`);
      }
    }, 600);
  }

  function handleBodyChange(sk, value) {
    updateTemplateStore(sk, { Body: value });
    clearTimeout(saveTimers.current[`${sk}_body`]);
    saveTimers.current[`${sk}_body`] = setTimeout(async () => {
      try {
        const current = useSmsStore
          .getState()
          .templates.find((t) => t.SmsTemplateSk === sk);
        if (!current) return;
        await updateSmsTemplate(sk, current.Name, current.Body);
      } catch (e) {
        logError(e, `SmsTemplatesScreen.handleBodyChange sk=${sk}`);
      }
    }, 600);
  }

  function handleDelete(sk) {
    Alert.alert(
      "Delete Template",
      "Are you sure you want to delete this template? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteSmsTemplate(sk);
              removeTemplate(sk);
            } catch (e) {
              logError(e, `SmsTemplatesScreen.handleDelete sk=${sk}`);
              Alert.alert("Error", "Could not delete template. Please try again.");
            }
          },
        },
      ],
    );
  }

  const canAdd = templates.length < MAX_TEMPLATES;

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
        <Text style={styles.navTitle}>SMS Templates</Text>
        <TouchableOpacity
          onPress={handleAdd}
          hitSlop={theme.layout.hitSlop.medium}
          disabled={!canAdd}
          style={{ opacity: canAdd ? 1 : 0.3 }}
        >
          <MaterialCommunityIcons
            name="plus"
            size={theme.layout.iconSize.l}
            color={theme.colors.primary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hint}>
          <MaterialCommunityIcons
            name="information-outline"
            size={14}
            color={theme.colors.textFine}
          />
          <Text style={styles.hintText}>
            Templates pre-fill the message when you tap the SMS icon on an
            inspection. Up to {MAX_TEMPLATES} templates allowed.
          </Text>
        </View>

        {templates.map((template, index) => (
          <TemplateCard
            key={template.SmsTemplateSk}
            template={template}
            index={index}
            onNameChange={(v) => handleNameChange(template.SmsTemplateSk, v)}
            onBodyChange={(v) => handleBodyChange(template.SmsTemplateSk, v)}
            onDelete={() => handleDelete(template.SmsTemplateSk)}
          />
        ))}

        {templates.length === 0 && (
          <View style={styles.empty}>
            <MaterialCommunityIcons
              name="message-text-outline"
              size={52}
              color={theme.colors.textFine}
            />
            <Text style={styles.emptyTitle}>No templates yet</Text>
            <Text style={styles.emptyBody}>
              Tap the + button to create your first SMS template.
            </Text>
          </View>
        )}

        {!canAdd && (
          <View style={styles.limitRow}>
            <MaterialCommunityIcons
              name="check-circle-outline"
              size={theme.layout.iconSize.m}
              color={theme.colors.textFine}
            />
            <Text style={styles.limitText}>
              {MAX_TEMPLATES} / {MAX_TEMPLATES} — maximum templates reached
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function TemplateCard({ template, index, onNameChange, onBodyChange, onDelete }) {
  const charCount = (template.Body ?? "").length;
  const overLimit = charCount > 160;

  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.header}>
        <Text style={cardStyles.indexLabel}>Template {index + 1}</Text>
        <TouchableOpacity
          onPress={onDelete}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={theme.layout.iconSize.m}
            color={theme.colors.textSubtle}
          />
        </TouchableOpacity>
      </View>

      <TextInput
        style={cardStyles.nameInput}
        value={template.Name}
        onChangeText={onNameChange}
        placeholder="Template name…"
        placeholderTextColor={theme.colors.textFine}
        returnKeyType="next"
        maxLength={60}
      />

      <View style={cardStyles.divider} />

      <TextInput
        style={cardStyles.bodyInput}
        value={template.Body}
        onChangeText={onBodyChange}
        placeholder="Message body…"
        placeholderTextColor={theme.colors.textFine}
        multiline
        maxLength={500}
        textAlignVertical="top"
        scrollEnabled={false}
      />

      <Text style={[cardStyles.charCount, overLimit && cardStyles.charOver]}>
        {charCount} / 160
      </Text>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.m,
    paddingHorizontal: theme.spacing.m,
    paddingTop: theme.spacing.s,
    paddingBottom: theme.spacing.xs,
    marginBottom: theme.spacing.m,
    ...theme.shadows.light,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: theme.spacing.xs,
  },
  indexLabel: {
    ...theme.typography.overline,
    color: theme.colors.primary,
  },
  nameInput: {
    ...theme.typography.bodyBold,
    color: theme.colors.text,
    paddingVertical: theme.spacing.xs,
  },
  divider: {
    height: theme.layout.borderWidth.thin,
    backgroundColor: theme.colors.input,
    marginVertical: theme.spacing.s,
  },
  bodyInput: {
    ...theme.typography.body,
    color: theme.colors.text,
    backgroundColor: theme.colors.mainBackground,
    borderRadius: theme.layout.borderRadius.s,
    padding: theme.spacing.s,
    minHeight: 80,
    lineHeight: 22,
  },
  charCount: {
    ...theme.typography.caption,
    color: theme.colors.textFine,
    textAlign: "right",
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  charOver: {
    color: theme.colors.warning,
    fontWeight: "600",
  },
});

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
  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.m,
  },
  hintText: {
    ...theme.typography.label,
    color: theme.colors.textFine,
    flex: 1,
    lineHeight: 18,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing.xxl * 2,
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
  limitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.s,
    paddingVertical: theme.spacing.s,
  },
  limitText: {
    ...theme.typography.label,
    color: theme.colors.textFine,
  },
});
