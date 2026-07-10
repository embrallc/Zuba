// AddressAutocomplete — a single "search an address" box that drives Google
// Places Autocomplete (New) and, on selection, hands the caller the structured
// address + authoritative lat/lng. Purpose-built for the Add/Edit Inspection
// LOCATION section: the five manual fields stay below it (editable, and the
// fallback for anyone who'd rather type). Renders nothing when no key is
// configured, so address entry never depends on this being set up.
//
// API:
//   <AddressAutocomplete onSelectAddress={({ line1, city, state, zip, lat, lng }) => …} />

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { theme } from "@theme";
import { AnimatePresence, MotiView } from "moti";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  fetchAddressPredictions,
  fetchPlaceDetails,
  newSessionToken,
  placesConfigured,
} from "../utils/placesAutocomplete";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

export default function AddressAutocomplete({
  onSelectAddress,
  placeholder = "Start typing an address…",
}) {
  const [query, setQuery] = useState("");
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(false);

  const sessionRef = useRef(null); // current billing session token (null between sessions)
  const abortRef = useRef(null); // AbortController for the in-flight request
  const debounceRef = useRef(null);
  // After a selection we set the query text programmatically; this flag skips the
  // search the resulting change would otherwise trigger.
  const suppressRef = useRef(false);

  const runSearch = useCallback(async (text) => {
    if (!sessionRef.current) sessionRef.current = newSessionToken();
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const results = await fetchAddressPredictions(text, sessionRef.current, {
      signal: controller.signal,
    });
    // A newer keystroke started while this was in flight — drop the stale result.
    if (abortRef.current !== controller) return;
    setPredictions(results);
    setLoading(false);
  }, []);

  // Debounced search on query change.
  useEffect(() => {
    if (suppressRef.current) {
      suppressRef.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      if (abortRef.current) abortRef.current.abort();
      setPredictions([]);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  // Cancel any in-flight work on unmount.
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handlePick = useCallback(
    async (prediction) => {
      const token = sessionRef.current;
      sessionRef.current = null; // end this session; next address mints a fresh token
      if (abortRef.current) abortRef.current.abort();
      setLoading(true);
      const details = await fetchPlaceDetails(prediction.placeId, token);
      setLoading(false);
      setPredictions([]);
      // Reflect the picked street line without re-triggering a search.
      suppressRef.current = true;
      setQuery(details?.line1 || prediction.primaryText || "");
      if (details) onSelectAddress?.(details);
    },
    [onSelectAddress],
  );

  // Nothing to render if the app was built without a Places key — the manual
  // fields below still work.
  if (!placesConfigured()) return null;

  const showDropdown = loading || predictions.length > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.searchRow}>
        <MaterialCommunityIcons
          name="magnify"
          size={18}
          color={theme?.colors?.icon}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor={theme?.colors?.textFine}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="search"
        />
        {loading ? (
          <ActivityIndicator size="small" color={theme?.colors?.primary} />
        ) : null}
      </View>

      <AnimatePresence>
        {showDropdown ? (
          <MotiView
            key="addr-suggestions"
            from={{ opacity: 0, translateY: -4 }}
            animate={{ opacity: 1, translateY: 0 }}
            exit={{ opacity: 0, translateY: -4 }}
            transition={{ type: "timing", duration: 160 }}
            style={styles.dropdown}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {predictions.map((p) => (
                <Pressable
                  key={p.placeId}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => handlePick(p)}
                >
                  <MaterialCommunityIcons
                    name="map-marker-outline"
                    size={16}
                    color={theme?.colors?.icon}
                    style={styles.rowIcon}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowPrimary} numberOfLines={1}>
                      {p.primaryText}
                    </Text>
                    {p.secondaryText ? (
                      <Text style={styles.rowSecondary} numberOfLines={1}>
                        {p.secondaryText}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
              {loading && predictions.length === 0 ? (
                <Text style={styles.searching}>Searching…</Text>
              ) : null}
            </ScrollView>
          </MotiView>
        ) : null}
      </AnimatePresence>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: theme?.spacing?.s,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.s,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.primary,
    paddingHorizontal: theme?.spacing?.m,
    minHeight: 44,
  },
  searchIcon: {
    marginRight: theme?.spacing?.s,
  },
  input: {
    flex: 1,
    paddingVertical: theme?.spacing?.s,
    ...theme?.typography?.body,
    color: theme?.colors?.text,
  },
  dropdown: {
    marginTop: theme?.spacing?.xs,
    backgroundColor: theme?.colors?.cardBackground,
    borderRadius: theme?.layout?.borderRadius?.s,
    borderWidth: theme?.layout?.borderWidth?.base,
    borderColor: theme?.colors?.input,
    maxHeight: 240,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.s,
    borderBottomWidth: theme?.layout?.borderWidth?.base,
    borderBottomColor: theme?.colors?.input,
  },
  rowPressed: {
    backgroundColor: theme?.colors?.primaryGhost,
  },
  rowIcon: {
    marginRight: theme?.spacing?.s,
  },
  rowText: {
    flex: 1,
  },
  rowPrimary: {
    ...theme?.typography?.body,
    color: theme?.colors?.text,
  },
  rowSecondary: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
  },
  searching: {
    ...theme?.typography?.caption,
    color: theme?.colors?.textSubtle,
    paddingHorizontal: theme?.spacing?.m,
    paddingVertical: theme?.spacing?.s,
  },
});
