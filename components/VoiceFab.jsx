import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { MotiView } from "moti";
import { useEffect, useRef } from "react";
import { Alert, Keyboard, StyleSheet, TouchableOpacity, View } from "react-native";
import { logError } from "../db/logs";
import { useVoiceStore } from "../stores/useVoiceStore";

const FAB_SIZE = (theme?.layout?.iconSize?.l ?? 28) * 2;

// Tuned for natural dictation — long enough to capture full sentences,
// short enough to commit interim text reasonably often. iOS will end the
// session on its own around the one-minute mark; we restart on `end` when
// the user still has voice enabled.
const RECOGNITION_OPTIONS = {
  lang: "en-US",
  // Stream partial results so text appears in the focused input as the user
  // speaks, rather than dumping the full utterance at the end.
  interimResults: true,
  continuous: true,
  // Use Apple/Google servers for higher accuracy on longer utterances.
  requiresOnDeviceRecognition: false,
  // Add a touch of inertia so we don't fire on every micro-pause.
  // (Most engines treat this as a hint, not a guarantee.)
  addsPunctuation: true,
};

function startRecognition() {
  try {
    ExpoSpeechRecognitionModule.start(RECOGNITION_OPTIONS);
  } catch (e) {
    logError(e, "VoiceFab.startRecognition");
  }
}

function stopRecognition() {
  try {
    ExpoSpeechRecognitionModule.stop();
  } catch (_) {}
}

// Mount once inside any screen that should host the voice FAB. The component
// owns the recognition lifecycle (start/stop/restart) and pipes final results
// into whichever TextInput last registered itself via `useVoiceField`.
export default function VoiceFab({ keyboardHeight = 0, keyboardVisible = false }) {
  const enabled = useVoiceStore((s) => s.enabled);
  const listening = useVoiceStore((s) => s.listening);
  const pendingField = useVoiceStore((s) => s.pendingField);
  const setEnabled = useVoiceStore((s) => s.setEnabled);
  const setListening = useVoiceStore((s) => s.setListening);
  const handleTranscript = useVoiceStore((s) => s.handleTranscript);

  // Handle to the post-`end` restart timer so the unmount effect can cancel
  // a pending restart and avoid firing recognition on a torn-down screen.
  const restartTimer = useRef(null);

  // ── Recognition events ────────────────────────────────────────────────────
  useSpeechRecognitionEvent("start", () => setListening(true));

  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    // The session may have ended because the user switched fields and we
    // requested a flush. Apply the deferred switch now — the trailing final
    // (if any) has already been routed to the *previous* field above.
    useVoiceStore.getState().applyPendingField();
    // iOS ends the session every ~60s. Restart automatically while the user
    // still has voice toggled on.
    if (useVoiceStore.getState().enabled) {
      if (restartTimer.current) clearTimeout(restartTimer.current);
      restartTimer.current = setTimeout(() => {
        restartTimer.current = null;
        if (useVoiceStore.getState().enabled) startRecognition();
      }, 250);
    }
  });

  useSpeechRecognitionEvent("result", (event) => {
    const r = event?.results?.[0];
    if (!r?.transcript) return;
    // Stream every result (interim + final) so text lands in whichever field
    // is focused *right now*, instead of all-at-once at the end of the utterance.
    handleTranscript(r.transcript, !!event.isFinal);
  });

  useSpeechRecognitionEvent("error", (event) => {
    // Common: "no-speech" when user goes silent for a while. Not fatal —
    // the `end` handler will restart us. Log other errors.
    if (event?.error && event.error !== "no-speech") {
      logError(new Error(event.error), `VoiceFab.error ${event.message ?? ""}`);
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // When user toggles enabled → start. When disabled → stop. On unmount → stop.
  useEffect(() => {
    let cancelled = false;
    if (enabled) {
      (async () => {
        try {
          const perm =
            await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (cancelled) return;
          if (!perm?.granted) {
            Alert.alert(
              "Permission needed",
              "Voice dictation requires microphone and speech recognition permission.",
            );
            setEnabled(false);
            return;
          }
          startRecognition();
        } catch (e) {
          logError(e, "VoiceFab.enable");
          setEnabled(false);
        }
      })();
    } else {
      stopRecognition();
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, setEnabled]);

  // Hard stop when the host screen unmounts (the inspection form unmounting
  // is the "exit form" signal the user described).
  useEffect(() => {
    return () => {
      if (restartTimer.current) {
        clearTimeout(restartTimer.current);
        restartTimer.current = null;
      }
      useVoiceStore.getState().reset();
      stopRecognition();
    };
  }, []);

  // When a field switch is deferred (user tapped a new field mid-utterance),
  // ask the engine to flush. It will emit one last final result — that lands
  // in the *previous* field while it's still `currentField`. After `end`
  // fires, applyPendingField swaps in the new field and recognition restarts.
  useEffect(() => {
    if (pendingField && enabled) {
      stopRecognition();
    }
  }, [pendingField, enabled]);

  function handleToggle() {
    if (enabled) {
      // Disabling — dismiss the keyboard so the user sees the new state.
      Keyboard.dismiss();
      setEnabled(false);
    } else {
      setEnabled(true);
    }
  }

  // Sit just above the KeyboardToolbar when the keyboard is up so the FAB
  // remains tappable while the user is typing. ~56 is the toolbar's height.
  const bottom = keyboardVisible ? keyboardHeight + 56 + 12 : 24;

  return (
    <View style={[styles.container, { bottom }]} pointerEvents="box-none">
      {listening && (
        <MotiView
          from={{ opacity: 0.5, scale: 1 }}
          animate={{ opacity: 0, scale: 1.7 }}
          transition={{
            type: "timing",
            duration: 1400,
            loop: true,
            repeatReverse: false,
          }}
          style={[
            StyleSheet.absoluteFillObject,
            {
              borderRadius: FAB_SIZE / 2,
              backgroundColor: theme.colors.primary,
            },
          ]}
        />
      )}
      <TouchableOpacity
        onPress={handleToggle}
        activeOpacity={0.85}
        style={[
          styles.fab,
          enabled ? styles.fabOn : styles.fabOff,
        ]}
      >
        <MaterialCommunityIcons
          name={enabled ? "microphone" : "microphone-off"}
          size={FAB_SIZE * 0.5}
          color="#fff"
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: 20,
    width: FAB_SIZE,
    height: FAB_SIZE,
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.medium,
  },
  fabOn: {
    backgroundColor: theme.colors.primary,
  },
  fabOff: {
    backgroundColor: theme.colors.textSubtle,
  },
});
