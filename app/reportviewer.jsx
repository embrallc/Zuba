// Report viewer — scrollable preview of the generated PDF + share actions.
//
// Preview: iOS WKWebView renders local PDFs natively. Android's WebView does
// not render PDFs, so Android gets an info card + the share buttons (the
// share sheet routes to the user's PDF viewer). react-native-webview is
// loaded defensively so the screen degrades gracefully on a dev build that
// predates the native module.
//
// Share rules (per spec): Email button only when the inspection has an email,
// Text button only when it has a phone. Neither → no share row.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as MailComposer from "expo-mail-composer";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import * as SMS from "expo-sms";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { getInspectionById } from "../db/inspections";
import { logError } from "../db/logs";
import { useDebouncedPress } from "../hooks/useDebouncedPress";
import { useBannerStore } from "../stores/useBannerStore";
import { useInspectionStore } from "../stores/useInspectionStore";
import {
  generateInspectionReport,
  getOrRestoreReport,
  reportFileName,
} from "../utils/reports";

let WebView = null;
try {
  // Native module may be absent until the next EAS build — degrade to the
  // no-preview card instead of crashing the screen.
  WebView = require("react-native-webview").WebView;
} catch (_) {}

export default function ReportViewerScreen() {
  const router = useRouter();
  const { inspectionSk } = useLocalSearchParams();
  const storeInspection = useInspectionStore((s) => s.inspections[inspectionSk]);
  const showBanner = useBannerStore((s) => s.show);

  // Completed/archived inspections aren't in the active store — fall back to
  // SQLite so the Archive's "Report" action resolves them. undefined = still
  // looking up, null = genuinely not found.
  const [dbInspection, setDbInspection] = useState(undefined);
  useEffect(() => {
    if (storeInspection) return;
    let alive = true;
    getInspectionById(inspectionSk).then((row) => {
      if (alive) setDbInspection(row ?? null);
    });
    return () => {
      alive = false;
    };
  }, [storeInspection, inspectionSk]);
  const inspection = storeInspection ?? dbInspection ?? null;
  const loadingInspection = !storeInspection && dbInspection === undefined;

  // 'checking' | 'ready' | 'missing'
  const [fileState, setFileState] = useState("checking");
  const [path, setPath] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!inspection) return; // wait for the store/SQLite lookup to resolve
    let alive = true;
    (async () => {
      // Cache-first; if the OS purged the cache, this re-pulls the stored
      // copy from the cloud and re-caches it before showing anything.
      const local = await getOrRestoreReport(inspection);
      if (!alive) return;
      setPath(local);
      setFileState(local ? "ready" : "missing");
    })();
    return () => {
      alive = false;
    };
  }, [inspection?.InspectionSk, inspection?.LastReportPath]);

  const handleGenerate = useDebouncedPress(async () => {
    if (generating || !inspection) return;
    setGenerating(true);
    try {
      const result = await generateInspectionReport(inspection);
      setPath(result.path);
      setFileState("ready");
      showBanner({ message: "Report generated.", kind: "success" });
    } catch (e) {
      logError(e, `ReportViewer.handleGenerate sk=${inspectionSk}`);
      showBanner({
        message: e?.presentable ? e.message : "Couldn't generate the report.",
        kind: "error",
      });
    } finally {
      setGenerating(false);
    }
  });

  const canPreview = Platform.OS === "ios" && !!WebView;

  const handleEmail = useDebouncedPress(async () => {
    try {
      // Preferred path: the native mail composer pre-fills the recipient,
      // subject, body, and attaches the PDF.
      if (await MailComposer.isAvailableAsync()) {
        await MailComposer.composeAsync({
          recipients: inspection.Email ? [inspection.Email] : undefined,
          subject: `Inspection Report — ${inspection.AddressLine1 || inspection.FullName || ""}`,
          body: `Hi ${inspection.FullName || "there"},\n\nAttached is your inspection report.\n\nThank you!`,
          attachments: [path],
        });
        return;
      }
      // No native mail UI (Apple Mail not configured, or the user emails via
      // Gmail/Outlook). Fall back to the OS share sheet so they can still pick a
      // mail app and send the PDF rather than dead-ending.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: "application/pdf",
          UTI: "com.adobe.pdf",
          dialogTitle: "Email report",
        });
        return;
      }
      showBanner({
        message: "No email or sharing option is available on this device.",
        kind: "warning",
      });
    } catch (e) {
      logError(e, `ReportViewer.handleEmail sk=${inspectionSk}`);
    }
  });

  const handleText = useDebouncedPress(async () => {
    try {
      const available = await SMS.isAvailableAsync();
      if (!available) {
        showBanner({ message: "Messaging isn't available on this device.", kind: "warning" });
        return;
      }
      await SMS.sendSMSAsync(
        [inspection.Phone],
        `Hi ${inspection.FullName || "there"}, attached is your inspection report.`,
        {
          attachments: {
            uri: path,
            mimeType: "application/pdf",
            filename: reportFileName(inspection),
          },
        },
      );
    } catch (e) {
      logError(e, `ReportViewer.handleText sk=${inspectionSk}`);
    }
  });

  // Deliberate "hard copy" download: the OS share sheet's Save to Files
  // (iOS) / Files & Drive targets (Android) write the PDF outside our
  // purgeable cache, fully user-controlled.
  const handleSave = useDebouncedPress(async () => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        showBanner({ message: "Saving isn't available on this device.", kind: "warning" });
        return;
      }
      await Sharing.shareAsync(path, {
        mimeType: "application/pdf",
        UTI: "com.adobe.pdf",
        dialogTitle: "Save or share report",
      });
    } catch (e) {
      logError(e, `ReportViewer.handleSave sk=${inspectionSk}`);
    }
  });

  const hasEmail = !!inspection?.Email;
  const hasPhone = !!inspection?.Phone;

  if (loadingInspection) {
    return (
      <SafeAreaView style={styles.safe}>
        <Nav router={router} title="Report" />
        <Center spinner text="Opening…" />
      </SafeAreaView>
    );
  }

  if (!inspection) {
    return (
      <SafeAreaView style={styles.safe}>
        <Nav router={router} title="Report" />
        <Center icon="file-question-outline" text="This inspection is no longer available." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Nav
        router={router}
        title={inspection.FullName || "Report"}
        subtitle={
          inspection.LastReportAt
            ? `Generated ${dayjs(inspection.LastReportAt).format("MMM D [at] h:mm A")}`
            : null
        }
      />

      {fileState === "checking" && (
        <Center spinner text="Opening report…" />
      )}

      {fileState === "missing" && (
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="file-alert-outline"
            size={40}
            color={theme?.colors?.textFine}
          />
          <Text style={styles.centerText}>
            No report has been generated for this inspection yet.
          </Text>
          <TouchableOpacity
            style={[styles.genBtn, generating && { opacity: 0.6 }]}
            onPress={handleGenerate}
            disabled={generating}
            activeOpacity={0.8}
          >
            {generating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialCommunityIcons
                  name="file-document-outline"
                  size={18}
                  color="#fff"
                />
                <Text style={styles.shareBtnText}>Generate report</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {fileState === "ready" &&
        (canPreview ? (
          <WebView
            style={styles.viewer}
            source={{ uri: path }}
            // Only the local PDF may render in-app; links inside the PDF
            // open in the system browser instead of hijacking this view.
            originWhitelist={["file://*", "about:*"]}
            onShouldStartLoadWithRequest={(req) => {
              if (
                req.url.startsWith("file://") ||
                req.url.startsWith("about:")
              ) {
                return true;
              }
              Linking.openURL(req.url).catch(() => {});
              return false;
            }}
            allowFileAccess
            allowingReadAccessToURL={path}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.viewerLoading}>
                <ActivityIndicator size="large" color={theme?.colors?.primary} />
              </View>
            )}
          />
        ) : (
          <Center
            icon="file-check-outline"
            text={
              WebView
                ? "The report is ready. In-app preview isn't supported on Android yet — use the buttons below to send it."
                : "The report is ready. Preview needs an app update — use the buttons below to send it."
            }
          />
        ))}

      {fileState === "ready" && (
        <View style={styles.shareRow}>
          {hasEmail && (
            <TouchableOpacity style={styles.shareBtn} onPress={handleEmail} activeOpacity={0.8}>
              <MaterialCommunityIcons name="email-outline" size={18} color="#fff" />
              <Text style={styles.shareBtnText}>Email</Text>
            </TouchableOpacity>
          )}
          {hasPhone && (
            <TouchableOpacity style={styles.shareBtn} onPress={handleText} activeOpacity={0.8}>
              <MaterialCommunityIcons name="message-text-outline" size={18} color="#fff" />
              <Text style={styles.shareBtnText}>Text</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.shareBtn, styles.saveBtn]}
            onPress={handleSave}
            activeOpacity={0.8}
          >
            <MaterialCommunityIcons
              name="download-outline"
              size={18}
              color={theme?.colors?.primary}
            />
            <Text style={[styles.shareBtnText, styles.saveBtnText]}>Save</Text>
          </TouchableOpacity>
        </View>
      )}

    </SafeAreaView>
  );
}

function Nav({ router, title, subtitle }) {
  return (
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
      <View style={styles.navText}>
        <Text style={styles.navTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.navSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={{ width: theme?.layout?.iconSize?.l }} />
    </View>
  );
}

function Center({ icon, text, spinner }) {
  return (
    <View style={styles.center}>
      {spinner ? (
        <ActivityIndicator size="large" color={theme?.colors?.primary} />
      ) : (
        <MaterialCommunityIcons
          name={icon}
          size={40}
          color={theme?.colors?.textFine}
        />
      )}
      <Text style={styles.centerText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    borderBottomWidth: theme?.layout?.borderWidth?.thin,
    borderBottomColor: theme?.colors?.input,
    ...(theme?.shadows?.light ?? {}),
  },
  navText: {
    flex: 1,
    alignItems: "center",
  },
  navTitle: {
    ...(theme?.typography?.h4 ?? {}),
  },
  navSubtitle: {
    ...(theme?.typography?.caption ?? {}),
    color: theme?.colors?.textFine,
    marginTop: 1,
  },
  viewer: {
    flex: 1,
    backgroundColor: theme?.colors?.mainBackground,
  },
  viewerLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme?.colors?.mainBackground,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.m,
    paddingHorizontal: theme?.spacing?.xl,
  },
  centerText: {
    ...(theme?.typography?.body ?? {}),
    color: theme?.colors?.textSubtle,
    textAlign: "center",
    lineHeight: 20,
  },
  shareRow: {
    flexDirection: "row",
    gap: theme?.spacing?.s,
    padding: theme?.spacing?.m,
    backgroundColor: theme?.colors?.cardBackground,
    borderTopWidth: theme?.layout?.borderWidth?.thin,
    borderTopColor: theme?.colors?.input,
  },
  shareBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.xs,
    backgroundColor: theme?.colors?.primary,
    borderRadius: theme?.layout?.borderRadius?.full,
    paddingVertical: theme?.spacing?.s,
  },
  shareBtnText: {
    ...(theme?.typography?.bodyBold ?? {}),
    color: "#fff",
    fontSize: 14,
  },
  saveBtn: {
    backgroundColor: theme?.colors?.cardBackground,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.primary,
  },
  saveBtnText: {
    color: theme?.colors?.primary,
  },
  genBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme?.spacing?.xs,
    backgroundColor: theme?.colors?.primary,
    borderRadius: theme?.layout?.borderRadius?.full,
    paddingVertical: theme?.spacing?.s,
    paddingHorizontal: theme?.spacing?.l,
    marginTop: theme?.spacing?.s,
  },
});
