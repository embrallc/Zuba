import { theme } from "@theme";
import { Component } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { logError } from "../db/logs";

// Top-level React error boundary — the third leg of the catch-all net.
//
// utils/globalErrorHandler.js already catches uncaught JS errors + unhandled
// promise rejections (async, event handlers, timers). Those are invisible to
// React, but the inverse is also true: a throw DURING a component's render or
// lifecycle is invisible to ErrorUtils and would otherwise white-screen the app.
// This boundary catches exactly that case, logs it (tagged 'react:errorBoundary'
// with the component stack) so it ships to the cloud like any other error, and
// shows a recoverable fallback instead of a dead screen.
//
// Caveat: a boundary only catches errors thrown by its DESCENDANTS during render/
// lifecycle — not inside async callbacks/event handlers (the global handler owns
// those). Together they cover ≈ everything.
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // The boundary's own logging must never re-crash the boundary.
    try {
      logError(error, "react:errorBoundary", {
        componentStack: info?.componentStack ?? null,
      });
    } catch {
      // swallow — logging is best-effort here
    }
  }

  handleReset = () => {
    // Re-mount the tree. If the error is persistent it'll surface again, but a
    // transient render error (e.g. a momentary bad state) recovers cleanly.
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The app hit an unexpected error. Your data is safe. Tap below to reload
          this screen.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={this.handleReset}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>Reload</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: theme?.spacing?.l ?? 24,
    backgroundColor: theme?.colors?.mainBackground ?? "#fff",
  },
  title: {
    ...(theme?.typography?.h2 ?? { fontSize: 22, fontWeight: "700" }),
    color: theme?.colors?.text ?? "#1c1c1e",
    marginBottom: theme?.spacing?.s ?? 8,
    textAlign: "center",
  },
  body: {
    ...(theme?.typography?.body ?? { fontSize: 15 }),
    color: theme?.colors?.textSubtle ?? "#6b7280",
    textAlign: "center",
    marginBottom: theme?.spacing?.l ?? 24,
  },
  button: {
    backgroundColor: theme?.colors?.primary ?? "#2f6fed",
    borderRadius: theme?.layout?.borderRadius?.m ?? 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  buttonText: {
    ...(theme?.typography?.bodyBold ?? { fontSize: 15, fontWeight: "700" }),
    color: "#fff",
  },
});
