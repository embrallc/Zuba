// Photo markup editor.
//
// Entered from the pencil action on a walkthrough photo. Loads the underlying
// photo, overlays a Skia canvas, and lets the inspector freehand-draw / arrow /
// box / circle / line across the image to flag defects.
//
// The markup JSON is handed back to the walkthrough form via usePhotoMarkupStore
// and stored on the photo ref inside the inspection's answers. Coordinates are
// normalized to [0,1] of the canvas so it renders correctly at any size.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  Canvas,
  Circle,
  Path,
  Rect,
  Skia,
} from "@shopify/react-native-skia";
import { theme } from "@theme";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { logError } from "../db/logs";
import { usePhotoMarkupStore } from "../stores/usePhotoWorkflow";

const COLORS = [
  "#FF3B30", // red
  "#FF9500", // orange
  "#FFCC00", // yellow
  "#34C759", // green
  "#0A84FF", // blue
  "#FFFFFF", // white
];

const WIDTHS = [
  { key: "thin", value: 0.004 },
  { key: "medium", value: 0.008 },
  { key: "thick", value: 0.014 },
];

const TOOLS = [
  { key: "select", icon: "cursor-default-outline" },
  { key: "pen", icon: "draw" },
  { key: "line", icon: "minus" },
  { key: "arrow", icon: "arrow-top-right" },
  { key: "rect", icon: "rectangle-outline" },
  { key: "ellipse", icon: "ellipse-outline" },
];

// Hit-test tolerances in normalized canvas units (0..1).
const HIT_TOLERANCE = 0.025;
const HANDLE_HIT = 0.04;

function parseInitialMarkup(json) {
  if (!json) return [];
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    return Array.isArray(parsed?.strokes) ? parsed.strokes : [];
  } catch (_) {
    return [];
  }
}

export default function PhotoEditScreen() {
  const router = useRouter();
  const { uri, initialMarkup, target } = useLocalSearchParams();
  const screen = useWindowDimensions();

  // Canvas size: full screen width, height derived from the photo's natural
  // aspect ratio (defaults to 4:3 until we learn the real dimensions).
  const [imgAspect, setImgAspect] = useState(4 / 3);
  // The image actually drawn on. We bake the photo UPRIGHT (EXIF orientation
  // applied) before editing so the canvas AND the stored [0,1] coordinates live
  // in the same orientation the report worker renders in (sharp `.rotate()`).
  // Why this matters: Image.getSize returns the UNORIENTED pixel dimensions for a
  // rotated (portrait) phone photo, while <Image> displays it upright — so the
  // canvas came out the wrong shape and every markup x-coordinate got compressed
  // (a wide ellipse printed as a near-circle). Baking removes the ambiguity.
  const [editUri, setEditUri] = useState(null);
  const canvasW = screen.width;
  const canvasH = Math.min(canvasW / imgAspect, screen.height * 0.62);

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    (async () => {
      try {
        const rendered = await ImageManipulator.manipulate(uri).renderAsync();
        const result = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.9,
        });
        if (cancelled) return;
        if (result?.width > 0 && result?.height > 0) {
          setImgAspect(result.width / result.height);
        }
        setEditUri(result?.uri || uri);
      } catch (e) {
        logError(e, "PhotoEditScreen.orientImage");
        if (cancelled) return;
        // Fallback: edit the original directly. Unoriented size still beats the
        // 4:3 default; this path only degrades markup on rotated photos.
        setEditUri(uri);
        Image.getSize(
          uri,
          (w, h) => {
            if (!cancelled && w > 0 && h > 0) setImgAspect(w / h);
          },
          (err) => logError(err, "PhotoEditScreen.Image.getSize"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri]);

  // Strokes. `committed` holds finished shapes; `pending` holds the one
  // currently being drawn (rendered separately so we don't allocate a new
  // committed array on every touch update).
  const initialStrokes = useMemo(
    () => parseInitialMarkup(initialMarkup),
    [initialMarkup],
  );
  const [committed, setCommitted] = useState(initialStrokes);
  const [pending, setPending] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);

  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#FF3B30");
  const [widthFrac, setWidthFrac] = useState(WIDTHS[1].value);
  const [saving, setSaving] = useState(false);

  // Refs the gesture callbacks read so they see fresh state inside a single
  // touch (a Pan re-uses its closure across onUpdate calls, so reading the
  // raw state would be one render stale).
  const committedRef = useRef(committed);
  const selectedIdxRef = useRef(selectedIdx);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const widthRef = useRef(widthFrac);
  const dragRef = useRef(null); // { mode: 'start'|'end', idx: number }
  useEffect(() => { committedRef.current = committed; }, [committed]);
  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { widthRef.current = widthFrac; }, [widthFrac]);

  // Picking a drawing tool clears any current selection.
  useEffect(() => {
    if (tool !== "select") setSelectedIdx(null);
  }, [tool]);

  // ── Gesture handlers ────────────────────────────────────────────────────

  function beginStroke(params) {
    const { tool: t, color: c, width: w, x, y } = params;
    if (t === "pen") {
      setPending({ tool: t, color: c, width: w, points: [{ x, y }] });
    } else {
      setPending({ tool: t, color: c, width: w, start: { x, y }, end: { x, y } });
    }
  }

  function extendStroke(p) {
    setPending((prev) => {
      if (!prev) return prev;
      if (prev.tool === "pen") {
        return { ...prev, points: [...prev.points, p] };
      }
      return { ...prev, end: p };
    });
  }

  function endStroke() {
    setPending((prev) => {
      if (prev) setCommitted((c) => [...c, prev]);
      return null;
    });
  }

  function handlePanStart({ x, y }) {
    const t = toolRef.current;
    if (t !== "select") {
      beginStroke({
        tool: t,
        color: colorRef.current,
        width: widthRef.current,
        x,
        y,
      });
      return;
    }
    // Select mode: check endpoint handles of the current selection first,
    // then hit-test all strokes front-to-back, otherwise deselect.
    const sel = selectedIdxRef.current;
    if (sel !== null) {
      const s = committedRef.current[sel];
      if (s && s.tool !== "pen") {
        const ds = Math.hypot(x - s.start.x, y - s.start.y);
        const de = Math.hypot(x - s.end.x, y - s.end.y);
        const mode = ds <= de ? "start" : "end";
        if (Math.min(ds, de) <= HANDLE_HIT) {
          dragRef.current = { mode, idx: sel };
          return;
        }
      }
    }
    const list = committedRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      if (hitTestStroke(list[i], x, y)) {
        setSelectedIdx(i);
        return;
      }
    }
    setSelectedIdx(null);
  }

  function handlePanUpdate({ x, y }) {
    if (toolRef.current !== "select") {
      extendStroke({ x, y });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    setCommitted((cs) =>
      cs.map((s, i) => {
        if (i !== drag.idx) return s;
        if (drag.mode === "start") return { ...s, start: { x, y } };
        if (drag.mode === "end") return { ...s, end: { x, y } };
        return s;
      }),
    );
  }

  function handlePanEnd() {
    if (toolRef.current !== "select") {
      endStroke();
      return;
    }
    dragRef.current = null;
  }

  const pan = Gesture.Pan()
    .minDistance(0)
    .onStart((e) => {
      "worklet";
      runOnJS(handlePanStart)({ x: e.x / canvasW, y: e.y / canvasH });
    })
    .onUpdate((e) => {
      "worklet";
      runOnJS(handlePanUpdate)({ x: e.x / canvasW, y: e.y / canvasH });
    })
    .onEnd(() => {
      "worklet";
      runOnJS(handlePanEnd)();
    });

  // ── Actions ─────────────────────────────────────────────────────────────

  function handleUndo() {
    setCommitted((c) => c.slice(0, -1));
    setSelectedIdx(null);
  }

  // Trash is context-aware: with a selection it deletes only that stroke,
  // otherwise it clears everything.
  function handleTrash() {
    if (selectedIdx !== null) {
      setCommitted((cs) => cs.filter((_, i) => i !== selectedIdx));
      setSelectedIdx(null);
    } else {
      setCommitted([]);
    }
  }

  // Color / width selectors also re-style the active selection when one
  // exists, so users can fix up a stroke without redrawing.
  function pickColor(c) {
    setColor(c);
    if (selectedIdx !== null) {
      setCommitted((cs) =>
        cs.map((s, i) => (i === selectedIdx ? { ...s, color: c } : s)),
      );
    }
  }

  function pickWidth(w) {
    setWidthFrac(w);
    if (selectedIdx !== null) {
      setCommitted((cs) =>
        cs.map((s, i) => (i === selectedIdx ? { ...s, width: w } : s)),
      );
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      // Empty strokes → null so the thumbnail icon goes back to gray and the
      // cloud column doesn't carry a `{strokes:[]}` placeholder.
      const json =
        committed.length > 0
          ? JSON.stringify({ v: 1, strokes: committed })
          : null;
      // Hand the markup back to the walkthrough form; the photo lives on a ref
      // inside the inspection's answers JSON, keyed by `target` (the photo id).
      usePhotoMarkupStore.getState().setResult({ photoId: target, markup: json });
      router.back();
    } catch (e) {
      logError(e, `PhotoEditScreen.handleSave target=${target}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const selectedStroke =
    selectedIdx !== null ? committed[selectedIdx] : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.navbar}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={theme.layout.hitSlop.medium}
        >
          <Text style={styles.navCancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>Markup</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={saving}
          hitSlop={theme.layout.hitSlop.medium}
        >
          {saving ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <Text style={styles.navSave}>Done</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.canvasWrap}>
        {!editUri ? (
          <ActivityIndicator size="large" color={theme.colors.primary} />
        ) : (
          <View style={{ width: canvasW, height: canvasH }}>
            <Image
              source={{ uri: editUri }}
              style={StyleSheet.absoluteFillObject}
              resizeMode="contain"
            />
            <GestureDetector gesture={pan}>
            <Canvas
              style={[StyleSheet.absoluteFillObject, { backgroundColor: "transparent" }]}
            >
              {selectedStroke &&
                renderStroke(selectedStroke, canvasW, canvasH, "halo", {
                  extraWidth: 10,
                  color: "rgba(168,85,247,0.45)",
                })}
              {committed.map((s, i) =>
                renderStroke(s, canvasW, canvasH, `c-${i}`),
              )}
              {selectedStroke &&
                renderHandles(
                  selectedStroke,
                  canvasW,
                  canvasH,
                  theme.colors.primary,
                )}
              {pending && renderStroke(pending, canvasW, canvasH, "pending")}
            </Canvas>
            </GestureDetector>
          </View>
        )}
      </View>

      <View style={styles.toolbar}>
        {/* Tools */}
        <View style={styles.toolRow}>
          {TOOLS.map((t) => {
            const selected = tool === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => setTool(t.key)}
                style={[styles.toolBtn, selected && styles.toolBtnSelected]}
              >
                <MaterialCommunityIcons
                  name={t.icon}
                  size={22}
                  color={selected ? "#fff" : theme.colors.text}
                />
              </TouchableOpacity>
            );
          })}
          <View style={styles.toolDivider} />
          <TouchableOpacity onPress={handleUndo} style={styles.toolBtn}>
            <MaterialCommunityIcons
              name="undo"
              size={22}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleTrash} style={styles.toolBtn}>
            <MaterialCommunityIcons
              name={
                selectedIdx !== null
                  ? "trash-can"
                  : "trash-can-outline"
              }
              size={22}
              color={theme.colors.error}
            />
          </TouchableOpacity>
        </View>

        {/* Colors */}
        <View style={styles.colorRow}>
          {COLORS.map((c) => {
            const selected = color === c;
            return (
              <TouchableOpacity
                key={c}
                onPress={() => pickColor(c)}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: c },
                  selected && styles.colorSwatchSelected,
                ]}
              />
            );
          })}
          <View style={styles.toolDivider} />
          {WIDTHS.map((w) => {
            const selected = widthFrac === w.value;
            const dot = 4 + WIDTHS.indexOf(w) * 4;
            return (
              <TouchableOpacity
                key={w.key}
                onPress={() => pickWidth(w.value)}
                style={[
                  styles.widthBtn,
                  selected && styles.widthBtnSelected,
                ]}
              >
                <View
                  style={{
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: selected ? "#fff" : theme.colors.text,
                  }}
                />
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function hitTestStroke(s, x, y) {
  switch (s.tool) {
    case "pen": {
      for (let i = 1; i < s.points.length; i++) {
        if (distToSegment(x, y, s.points[i - 1], s.points[i]) <= HIT_TOLERANCE)
          return true;
      }
      return false;
    }
    case "line":
    case "arrow":
      return distToSegment(x, y, s.start, s.end) <= HIT_TOLERANCE;
    case "rect": {
      const x1 = Math.min(s.start.x, s.end.x);
      const x2 = Math.max(s.start.x, s.end.x);
      const y1 = Math.min(s.start.y, s.end.y);
      const y2 = Math.max(s.start.y, s.end.y);
      const d = Math.min(
        distToSegment(x, y, { x: x1, y: y1 }, { x: x2, y: y1 }),
        distToSegment(x, y, { x: x2, y: y1 }, { x: x2, y: y2 }),
        distToSegment(x, y, { x: x1, y: y2 }, { x: x2, y: y2 }),
        distToSegment(x, y, { x: x1, y: y1 }, { x: x1, y: y2 }),
      );
      return d <= HIT_TOLERANCE;
    }
    case "ellipse": {
      const cx = (s.start.x + s.end.x) / 2;
      const cy = (s.start.y + s.end.y) / 2;
      const rx = Math.max(0.005, Math.abs(s.end.x - s.start.x) / 2);
      const ry = Math.max(0.005, Math.abs(s.end.y - s.start.y) / 2);
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      // Project unit-ellipse deviation back to pixels with the smaller radius.
      return Math.abs(d - 1) * Math.min(rx, ry) <= HIT_TOLERANCE;
    }
    default:
      return false;
  }
}

// ─── Stroke renderers ─────────────────────────────────────────────────────────

function renderStroke(s, W, H, key, override = {}) {
  const sw = Math.max(1, (s.width ?? 0.008) * W) + (override.extraWidth ?? 0);
  const color = override.color ?? s.color;
  switch (s.tool) {
    case "pen": {
      const path = Skia.Path.Make();
      s.points.forEach((p, i) => {
        const x = p.x * W;
        const y = p.y * H;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      return (
        <Path
          key={key}
          path={path}
          color={color}
          style="stroke"
          strokeWidth={sw}
          strokeCap="round"
          strokeJoin="round"
        />
      );
    }
    case "line": {
      const path = Skia.Path.Make();
      path.moveTo(s.start.x * W, s.start.y * H);
      path.lineTo(s.end.x * W, s.end.y * H);
      return (
        <Path
          key={key}
          path={path}
          color={color}
          style="stroke"
          strokeWidth={sw}
          strokeCap="round"
        />
      );
    }
    case "arrow": {
      const sx = s.start.x * W;
      const sy = s.start.y * H;
      const ex = s.end.x * W;
      const ey = s.end.y * H;
      const angle = Math.atan2(ey - sy, ex - sx);
      const ah = Math.max(sw * 3, 12);
      const path = Skia.Path.Make();
      path.moveTo(sx, sy);
      path.lineTo(ex, ey);
      // Two short lines off the tip form the arrowhead.
      path.moveTo(ex, ey);
      path.lineTo(
        ex - ah * Math.cos(angle - Math.PI / 6),
        ey - ah * Math.sin(angle - Math.PI / 6),
      );
      path.moveTo(ex, ey);
      path.lineTo(
        ex - ah * Math.cos(angle + Math.PI / 6),
        ey - ah * Math.sin(angle + Math.PI / 6),
      );
      return (
        <Path
          key={key}
          path={path}
          color={color}
          style="stroke"
          strokeWidth={sw}
          strokeCap="round"
          strokeJoin="round"
        />
      );
    }
    case "rect": {
      const x = Math.min(s.start.x, s.end.x) * W;
      const y = Math.min(s.start.y, s.end.y) * H;
      const w = Math.abs(s.end.x - s.start.x) * W;
      const h = Math.abs(s.end.y - s.start.y) * H;
      return (
        <Rect
          key={key}
          x={x}
          y={y}
          width={w}
          height={h}
          color={color}
          style="stroke"
          strokeWidth={sw}
        />
      );
    }
    case "ellipse": {
      const cx = ((s.start.x + s.end.x) / 2) * W;
      const cy = ((s.start.y + s.end.y) / 2) * H;
      const rx = (Math.abs(s.end.x - s.start.x) / 2) * W;
      const ry = (Math.abs(s.end.y - s.start.y) / 2) * H;
      const path = Skia.Path.Make();
      path.addOval({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 });
      return (
        <Path
          key={key}
          path={path}
          color={color}
          style="stroke"
          strokeWidth={sw}
        />
      );
    }
    default:
      return null;
  }
}

// Endpoint drag handles drawn over the selected stroke. Pen strokes have no
// handles since they are freehand polylines.
function renderHandles(s, W, H, hi) {
  if (!s || s.tool === "pen") return null;
  const sx = s.start.x * W;
  const sy = s.start.y * H;
  const ex = s.end.x * W;
  const ey = s.end.y * H;
  return (
    <>
      <Circle cx={sx} cy={sy} r={10} color="#fff" />
      <Circle cx={sx} cy={sy} r={6} color={hi} />
      <Circle cx={ex} cy={ey} r={10} color="#fff" />
      <Circle cx={ex} cy={ey} r={6} color={hi} />
    </>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#000",
  },
  navbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.m,
    paddingVertical: theme.spacing.s,
    backgroundColor: "#0a0a0a",
  },
  navTitle: {
    ...theme.typography.bodyBold,
    color: "#fff",
  },
  navCancel: {
    ...theme.typography.body,
    color: theme.colors.textSubtle,
  },
  navSave: {
    ...theme.typography.bodyBold,
    color: theme.colors.primary,
  },
  canvasWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
  toolbar: {
    backgroundColor: "#0a0a0a",
    paddingVertical: theme.spacing.s,
    paddingHorizontal: theme.spacing.s,
    gap: theme.spacing.s,
    borderTopWidth: theme.layout.borderWidth.thin,
    borderTopColor: "#222",
  },
  toolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
  },
  colorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.s,
  },
  toolBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.layout.borderRadius.m,
    backgroundColor: "#1a1a1a",
  },
  toolBtnSelected: {
    backgroundColor: theme.colors.primary,
  },
  toolDivider: {
    width: 1,
    height: 28,
    backgroundColor: "#333",
    marginHorizontal: 4,
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorSwatchSelected: {
    borderColor: "#fff",
  },
  widthBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.layout.borderRadius.m,
    backgroundColor: "#1a1a1a",
  },
  widthBtnSelected: {
    backgroundColor: theme.colors.primary,
  },
});
