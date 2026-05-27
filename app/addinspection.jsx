import { MaterialCommunityIcons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { theme } from "@theme";
import dayjs from "dayjs";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AnimatePresence, MotiView } from "moti";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import KeyboardToolbar from "../components/KeyboardToolbar";
import { insertInspection, updateInspection } from "../db/inspections";
import { logError } from "../db/logs";
import { useInspectionStore } from "../stores/useInspectionStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { maybePromptForUpcomingApptNotif } from "../utils/notifications";
import { findOverlappingInspection } from "../utils/overlapUtils";

const FIELD_ORDER = [
  "FullName",
  "Phone",
  "Email",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "ZipCode",
];

const EMAIL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
];

export default function AddInspectionScreen() {
  const router = useRouter();
  const { inspectionSk, prefilledAt } = useLocalSearchParams();
  const isEditing = !!inspectionSk;

  const getById = useInspectionStore((s) => s.getById);
  const addToStore = useInspectionStore((s) => s.add);
  const updateInStore = useInspectionStore((s) => s.update);
  const allInspections = useInspectionStore((s) => s.inspections);
  const userSk = useSettingsStore((s) => s.userSk);
  const apptLengthMinutes = useSettingsStore((s) => s.apptLengthMinutes);

  const existing = isEditing ? getById(inspectionSk) : null;

  const [scheduledAt, setScheduledAt] = useState(() => {
    if (existing?.ScheduledAt) return new Date(existing.ScheduledAt);
    if (prefilledAt) return new Date(prefilledAt);
    return new Date();
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    FullName: existing?.FullName ?? "",
    Phone: existing?.Phone ?? "",
    Email: existing?.Email ?? "",
    AddressLine1: existing?.AddressLine1 ?? "",
    AddressLine2: existing?.AddressLine2 ?? "",
    City: existing?.City ?? "",
    State: existing?.State ?? "",
    ZipCode: existing?.ZipCode ?? "",
  });

  const [geo, setGeo] = useState({
    Latitude: existing?.Latitude ?? null,
    Longitude: existing?.Longitude ?? null,
  });

  // Holds a Promise that resolves to {Latitude, Longitude} | null when geocoding
  // is in-flight, so handleSave can await it rather than saving stale null coords.
  const geocodingRef = useRef(null);

  // ── Keyboard toolbar state ────────────────────────────────────────────────
  const inputRefs = useRef({});
  const [focusedField, setFocusedField] = useState(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(showEvent, (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const onHide = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  const currentIndex = FIELD_ORDER.indexOf(focusedField);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < FIELD_ORDER.length - 1;

  function focusPrev() {
    if (canGoPrev) inputRefs.current[FIELD_ORDER[currentIndex - 1]]?.focus();
  }
  function focusNext() {
    if (canGoNext) inputRefs.current[FIELD_ORDER[currentIndex + 1]]?.focus();
  }

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Auto-geocode when full address is present.
  // Stores a Promise in geocodingRef so handleSave can await it if the user
  // taps Save before the debounce + geocode round-trip finishes.
  useEffect(() => {
    const { AddressLine1, City, State, ZipCode } = form;
    if (!AddressLine1 || !City || !State || !ZipCode) {
      geocodingRef.current = null;
      return;
    }

    let resolveGeo;
    geocodingRef.current = new Promise((res) => {
      resolveGeo = res;
    });

    let cancelled = false;
    const timeout = setTimeout(async () => {
      try {
        const results = await Location.geocodeAsync(
          `${AddressLine1}, ${City}, ${State} ${ZipCode}`,
        );
        if (cancelled) return;
        const first = results?.[0];
        const coords =
          first?.latitude != null && first?.longitude != null
            ? { Latitude: first.latitude, Longitude: first.longitude }
            : null;
        if (coords) setGeo(coords);
        resolveGeo(coords);
      } catch (e) {
        if (cancelled) return;
        logError(
          e,
          `AddInspectionScreen.geocode addr="${AddressLine1}, ${City}, ${State} ${ZipCode}"`,
        );
        resolveGeo(null);
      }
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      resolveGeo(null);
    };
  }, [form.AddressLine1, form.City, form.State, form.ZipCode]);

  async function handleSave() {
    if (!form.FullName.trim()) {
      Alert.alert("Required", "Full name is required.");
      return;
    }

    const overlap = findOverlappingInspection(
      scheduledAt,
      apptLengthMinutes,
      allInspections,
      isEditing ? inspectionSk : null,
    );
    if (overlap) {
      const name = overlap.FullName || "another inspection";
      const time = dayjs(overlap.ScheduledAt).format("h:mm A");
      Alert.alert(
        "Scheduling Conflict",
        `This appointment overlaps with ${name} at ${time}. Please choose a different time.`,
      );
      return;
    }

    setSaving(true);

    // If address is present but coords aren't captured yet, wait for the
    // in-flight geocoding promise before saving (shows spinner during wait).
    let lat = geo.Latitude;
    let lng = geo.Longitude;
    const hasAddress =
      form.AddressLine1 && form.City && form.State && form.ZipCode;
    if (hasAddress && !lat && geocodingRef.current) {
      const coords = await geocodingRef.current.catch(() => null);
      if (coords?.Latitude != null && coords?.Longitude != null) {
        lat = coords.Latitude;
        lng = coords.Longitude;
      }
    }

    const data = {
      ...form,
      Summary: existing?.Summary ?? "",
      ScheduledAt: dayjs(scheduledAt).toISOString(),
      Latitude: lat,
      Longitude: lng,
    };

    try {
      if (isEditing) {
        const updated = await updateInspection(inspectionSk, data);
        updateInStore({ ...existing, ...updated });
      } else {
        const created = await insertInspection({ ...data, UserSk: userSk });
        addToStore(created);
        // First-inspection onboarding prompt for local reminders. No-op
        // after the first time it runs (AsyncStorage flag inside the helper).
        await maybePromptForUpcomingApptNotif({ userSk });
      }
      router.back();
    } catch (e) {
      logError(
        e,
        `AddInspectionScreen.handleSave sk=${inspectionSk ?? "new"} name="${form.FullName}"`,
      );
      Alert.alert("Error", "Could not save inspection. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function onDateChange(event, selected) {
    setShowDatePicker(Platform.OS === "ios");
    if (selected) {
      const merged = new Date(scheduledAt);
      merged.setFullYear(
        selected.getFullYear(),
        selected.getMonth(),
        selected.getDate(),
      );
      setScheduledAt(merged);
    }
  }

  function onTimeChange(event, selected) {
    setShowTimePicker(Platform.OS === "ios");
    if (selected) {
      const merged = new Date(scheduledAt);
      merged.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      setScheduledAt(merged);
    }
  }

  function refFor(field) {
    return (r) => {
      inputRefs.current[field] = r;
    };
  }
  function onFocusFor(field) {
    return () => setFocusedField(field);
  }

  // Email domain autocomplete: once the user types "@", show common domains
  // filtered by whatever partial domain they've typed. Suggestions hide once
  // the partial matches a domain exactly.
  const emailSuggestions = useMemo(() => {
    const at = form.Email.indexOf("@");
    if (at < 0) return [];
    const partial = form.Email.slice(at + 1).toLowerCase();
    if (EMAIL_DOMAINS.includes(partial)) return [];
    return EMAIL_DOMAINS.filter((d) => d.startsWith(partial));
  }, [form.Email]);

  function applyEmailDomain(domain) {
    const at = form.Email.indexOf("@");
    const local = at >= 0 ? form.Email.slice(0, at) : form.Email;
    set("Email", `${local}@${domain}`);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.navbar}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={theme.layout.hitSlop.medium}
          >
            <MaterialCommunityIcons
              name="close"
              size={theme.layout.iconSize.l}
              color={theme.colors.icon}
            />
          </TouchableOpacity>
          <Text style={styles.navTitle}>
            {isEditing ? "Edit Inspection" : "New Inspection"}
          </Text>
          <View style={{ width: theme.layout.iconSize.l }} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            keyboardVisible && { paddingBottom: keyboardHeight + 56 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionLabel}>CLIENT INFO</Text>

          <Field label="Full Name" required>
            <TextInput
              ref={refFor("FullName")}
              onFocus={onFocusFor("FullName")}
              style={styles.input}
              value={form.FullName}
              onChangeText={(v) => set("FullName", v)}
              placeholder="Jane Smith"
              placeholderTextColor={theme.colors.textFine}
              returnKeyType="next"
              onSubmitEditing={focusNext}
              autoCapitalize="words"
              autoCorrect={false}
            />
          </Field>

          <Field label="Phone">
            <TextInput
              ref={refFor("Phone")}
              onFocus={onFocusFor("Phone")}
              style={styles.input}
              value={form.Phone}
              onChangeText={(v) => set("Phone", v)}
              placeholder="(555) 555-5555"
              placeholderTextColor={theme.colors.textFine}
              keyboardType="phone-pad"
              returnKeyType="none"
              onSubmitEditing={focusNext}
            />
          </Field>

          <Field label="Email">
            <TextInput
              ref={refFor("Email")}
              onFocus={onFocusFor("Email")}
              style={styles.input}
              value={form.Email}
              onChangeText={(v) => set("Email", v)}
              placeholder="jane@example.com"
              placeholderTextColor={theme.colors.textFine}
              keyboardType="email-address"
              autoCapitalize="none"
              returnKeyType="next"
              onSubmitEditing={focusNext}
              autoCorrect={false}
              autoComplete="email"
            />
            <AnimatePresence>
              {emailSuggestions.length > 0 ? (
                <MotiView
                  key="email-suggestions"
                  from={{ opacity: 0, translateY: -4 }}
                  animate={{ opacity: 1, translateY: 0 }}
                  exit={{ opacity: 0, translateY: -4 }}
                  transition={{ type: "timing", duration: 160 }}
                >
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="handled"
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.emailSuggestionRow}
                  >
                    {emailSuggestions.map((d) => (
                      <TouchableOpacity
                        key={d}
                        style={styles.emailChip}
                        onPress={() => applyEmailDomain(d)}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.emailChipText}>@{d}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </MotiView>
              ) : null}
            </AnimatePresence>
          </Field>

          <Text style={styles.sectionLabel}>SCHEDULE</Text>

          <Field label="Date">
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowDatePicker(true)}
            >
              <Text style={styles.pickerText}>
                {dayjs(scheduledAt).format("MMMM D, YYYY")}
              </Text>
            </TouchableOpacity>
            {showDatePicker && (
              <DateTimePicker
                value={scheduledAt}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                onChange={onDateChange}
              />
            )}
          </Field>

          <Field label="Time">
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowTimePicker(true)}
            >
              <Text style={styles.pickerText}>
                {dayjs(scheduledAt).format("h:mm A")}
              </Text>
            </TouchableOpacity>
            {showTimePicker && (
              <DateTimePicker
                value={scheduledAt}
                mode="time"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                onChange={onTimeChange}
                minuteInterval={5}
              />
            )}
          </Field>

          <Text style={styles.sectionLabel}>LOCATION</Text>

          <Field label="Address Line 1">
            <TextInput
              ref={refFor("AddressLine1")}
              onFocus={onFocusFor("AddressLine1")}
              style={styles.input}
              value={form.AddressLine1}
              onChangeText={(v) => set("AddressLine1", v)}
              placeholder="123 Main St"
              placeholderTextColor={theme.colors.textFine}
              returnKeyType="next"
              onSubmitEditing={focusNext}
              autoCapitalize="words"
              autoCorrect={false}
            />
          </Field>

          <Field label="Address Line 2">
            <TextInput
              ref={refFor("AddressLine2")}
              onFocus={onFocusFor("AddressLine2")}
              style={styles.input}
              value={form.AddressLine2}
              onChangeText={(v) => set("AddressLine2", v)}
              placeholder="Apt, Suite, Unit (optional)"
              placeholderTextColor={theme.colors.textFine}
              returnKeyType="next"
              onSubmitEditing={focusNext}
              autoCapitalize="words"
              autoCorrect={false}
            />
          </Field>

          <View style={styles.row}>
            <View style={{ flex: 2 }}>
              <Field label="City">
                <TextInput
                  ref={refFor("City")}
                  onFocus={onFocusFor("City")}
                  style={styles.input}
                  value={form.City}
                  onChangeText={(v) => set("City", v)}
                  placeholder="Springfield"
                  placeholderTextColor={theme.colors.textFine}
                  returnKeyType="next"
                  onSubmitEditing={focusNext}
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="State">
                <TextInput
                  ref={refFor("State")}
                  onFocus={onFocusFor("State")}
                  style={styles.input}
                  value={form.State}
                  onChangeText={(v) => set("State", v.toUpperCase())}
                  placeholder="IL"
                  placeholderTextColor={theme.colors.textFine}
                  autoCapitalize="characters"
                  maxLength={2}
                  returnKeyType="next"
                  onSubmitEditing={focusNext}
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="ZIP">
                <TextInput
                  ref={refFor("ZipCode")}
                  onFocus={onFocusFor("ZipCode")}
                  style={styles.input}
                  value={form.ZipCode}
                  onChangeText={(v) => set("ZipCode", v)}
                  placeholder="62701"
                  placeholderTextColor={theme.colors.textFine}
                  keyboardType="number-pad"
                  maxLength={10}
                  returnKeyType="none"
                  onSubmitEditing={focusNext}
                />
              </Field>
            </View>
          </View>

          {/* Animated geo confirmation */}
          <AnimatePresence>
            {geo.Latitude ? (
              <MotiView
                key="geo"
                from={{ opacity: 0, scale: 0.85, translateY: -8 }}
                animate={{ opacity: 1, scale: 1, translateY: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", damping: 14, stiffness: 180 }}
                style={styles.geoConfirmRow}
              >
                <MaterialCommunityIcons
                  name="map-marker-check"
                  size={13}
                  color={theme.colors.success}
                />
                <Text style={styles.geoConfirm}>Location captured</Text>
              </MotiView>
            ) : null}
          </AnimatePresence>

          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.saveBtnText}>Save Inspection</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <KeyboardToolbar
        visible={keyboardVisible}
        keyboardHeight={keyboardHeight}
        canGoPrev={canGoPrev}
        canGoNext={canGoNext}
        onPrev={focusPrev}
        onNext={focusNext}
        onSave={handleSave}
      />
    </SafeAreaView>
  );
}

function Field({ label, required, children }) {
  return (
    <View style={fieldStyles.container}>
      <Text style={fieldStyles.label}>
        {label}
        {required ? <Text style={fieldStyles.required}> *</Text> : null}
      </Text>
      {children}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  container: {
    marginBottom: theme.spacing.m,
  },
  label: {
    ...theme.typography.label,
    marginBottom: theme.spacing.xs,
  },
  required: {
    color: theme.colors.warning,
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
    borderBottomWidth: 0,
    ...theme.shadows.light,
  },
  navTitle: {
    ...theme.typography.h4,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing.m,
    paddingBottom: theme.spacing.xxl,
  },
  sectionLabel: {
    ...theme.typography.overline,
    marginTop: theme.spacing.m,
    marginBottom: theme.spacing.s,
  },
  input: {
    backgroundColor: theme.colors.cardBackground,
    borderRadius: theme.layout.borderRadius.s,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    ...theme.typography.body,
    minHeight: 42,
    justifyContent: "center",
  },
  pickerText: {
    ...theme.typography.body,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing.s,
  },
  emailSuggestionRow: {
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
    gap: theme.spacing.xs,
  },
  emailChip: {
    backgroundColor: theme.colors.cardBackground,
    borderWidth: theme.layout.borderWidth.base,
    borderColor: theme.colors.input,
    borderRadius: 999,
    paddingHorizontal: theme.spacing.s,
    paddingVertical: theme.spacing.xs,
    marginRight: theme.spacing.xs,
  },
  emailChipText: {
    ...theme.typography.caption,
    color: theme.colors.primary,
  },
  geoConfirmRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: -theme.spacing.s,
    marginBottom: theme.spacing.m,
  },
  geoConfirm: {
    ...theme.typography.caption,
    color: theme.colors.success,
  },
  saveBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.layout.borderRadius.m,
    paddingVertical: theme.spacing.m,
    alignItems: "center",
    marginTop: theme.spacing.xl,
    minHeight: 50,
    justifyContent: "center",
    ...theme.shadows.medium,
  },
  saveBtnDisabled: {
    opacity: theme.layout.opacity.disabled,
  },
  saveBtnText: {
    ...theme.typography.bodyBold,
    color: "#fff",
  },
});
