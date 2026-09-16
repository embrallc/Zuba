import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

// One-time modal telling a new owner to set up Google Drive backup NOW.
// See useDriveBackupPrompt for the once-per-org gating.
//
// The copy is deliberately blunt about the forward-only rule: an inspector who
// assumes their existing history came along would only find out years later,
// when a board asks for a record we never had.
export default function DriveBackupPrompt({ visible, onSetUp, onDismiss }) {
  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <MaterialCommunityIcons
              name="cloud-upload-outline"
              size={30}
              color={theme?.colors?.primary}
            />
          </View>

          <Text style={styles.title}>Back up your inspections</Text>

          <Text style={styles.body}>
            Connect your Google Drive and every inspection you complete is saved
            to your own account — the report PDF, all photos, and a data file
            with the full record. Most states require inspectors to keep records
            for years.
          </Text>

          <View style={styles.callout}>
            <MaterialCommunityIcons
              name="alert-outline"
              size={16}
              color={theme?.colors?.warning}
            />
            <Text style={styles.calloutText}>
              Backups only cover inspections completed after you connect.
              Anything finished before that needs a support request to recover.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            onPress={onSetUp}
            activeOpacity={0.85}
          >
            <Text style={styles.btnPrimaryTxt}>Set up backup</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondary}
            onPress={onDismiss}
            activeOpacity={0.7}
          >
            <Text style={styles.secondaryTxt}>Not now</Text>
          </TouchableOpacity>

          <Text style={styles.footnote}>
            You can set this up any time in Settings → Integrations.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(30,27,75,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme?.spacing?.l ?? 20,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.l,
    padding: theme?.spacing?.l,
    ...theme?.shadows?.dark,
  },
  iconWrap: {
    alignSelf: "center",
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme?.colors?.primaryGhost,
    marginBottom: theme?.spacing?.m,
  },
  title: { ...theme?.typography?.h3, textAlign: "center" },
  body: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    marginTop: theme?.spacing?.s,
    lineHeight: 20,
    textAlign: "center",
  },
  callout: {
    flexDirection: "row",
    gap: theme?.spacing?.s,
    backgroundColor: theme?.colors?.input,
    borderRadius: theme?.layout?.borderRadius?.m,
    padding: theme?.spacing?.m,
    marginTop: theme?.spacing?.m,
  },
  calloutText: {
    ...theme?.typography?.caption,
    color: theme?.colors?.text,
    flexShrink: 1,
    lineHeight: 17,
  },
  btn: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme?.layout?.borderRadius?.m,
    paddingVertical: theme?.spacing?.m,
    marginTop: theme?.spacing?.l,
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: theme?.colors?.primary, ...theme?.shadows?.medium },
  btnPrimaryTxt: { ...theme?.typography?.bodyBold, color: "#fff" },
  secondary: { alignItems: "center", paddingVertical: theme?.spacing?.m },
  secondaryTxt: {
    ...theme?.typography?.label,
    color: theme?.colors?.textSubtle,
    fontWeight: "600",
  },
  footnote: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textFine,
    textAlign: "center",
  },
});
