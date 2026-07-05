import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { hasToken } from "./api";
import { useAppStore } from "./appStore";
import { useWalkthroughStore } from "./walkthrough/store";

// First-run guided tour for the standalone builder (the marketing sandbox).
// Six spotlighted steps — three on the form designer, three on the report
// designer — then a "Happy building!" send-off. It drives the mode switch
// itself and highlights real DOM anchors (data-tour="…") so it always tracks
// the live UI. Sandbox-only (gated on !hasToken); shown once per browser, with
// a small "Take the tour" pill to replay. Nothing here persists.

const SEEN_KEY = "zanbi-builder-tour-seen";

// Select a real field so the "customize" step shows live inspector controls
// (not the empty-state). Falls back to the first section if none has fields.
function selectFirstField() {
  const st = useWalkthroughStore.getState();
  const t = st.template;
  const sec = t?.sections?.find((s) => (s.fields?.length ?? 0) > 0);
  if (sec) st.select({ kind: "field", sectionId: sec.id, fieldId: sec.fields[0].id });
  else if (t?.sections?.[0]) st.select({ kind: "section", sectionId: t.sections[0].id });
}

const STEPS = [
  {
    mode: "walkthrough",
    target: '[data-tour="wt-sections"]',
    placement: "right",
    title: "Two kinds of sections",
    body:
      "Every form is built from sections. A Static section appears once per inspection — like a summary. A Repeating section is stamped out again for every area the inspector walks (Basement, Roof, Kitchen): design it once, it repeats itself.",
  },
  {
    mode: "walkthrough",
    target: '[data-tour="wt-fields"]',
    placement: "right",
    title: "Drop in your fields",
    body:
      "These are your building blocks — text, yes/no, multiple choice, photos, severity ratings and more. Click one to add it to the selected section, or drag it straight onto the page.",
  },
  {
    mode: "walkthrough",
    target: ".inspector",
    placement: "left",
    before: selectFirstField,
    title: "Make it yours",
    body:
      "Select any field and its settings open here — rename it, add choices, mark it required, turn a text box into a multi-line note. Every change updates the live preview instantly.",
  },
  {
    mode: "report",
    target: '[data-tour="build-from-form"]',
    placement: "bottom",
    title: "Build from my form",
    body:
      "This is the magic button. One click turns the form you just designed into a matching, printable report layout — every section and field already placed. The perfect starting point.",
  },
  {
    mode: "report",
    target: '[data-tour="report-elements"]',
    placement: "right",
    title: "Design the page",
    body:
      "Drag in elements to lay the report out exactly how your clients should see it — text blocks, field lines, dividers, photo grids, and your own logo.",
  },
  {
    mode: "report",
    target: '[data-tour="report-datafields"]',
    placement: "right",
    title: "Your data, auto-filled",
    body:
      "Every field from your form shows up here as a Data Field. Drop one anywhere on the report and it fills itself in with whatever the inspector captured — no retyping, ever.",
  },
  {
    final: true,
    title: "Happy building! 🎉",
    body:
      "That's the whole loop: design the form, build the report, drop in your data. Poke around as much as you like — nothing here is saved, so you can't break a thing.",
  },
];

const ANCHORED = STEPS.filter((s) => !s.final).length;

export default function Tour() {
  const [active, setActive] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  const cardRef = useRef(null);
  const tokenRef = useRef(0);

  // Auto-start once per browser, sandbox only.
  useEffect(() => {
    if (hasToken) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch (_) {}
    if (seen) return;
    const t = setTimeout(() => {
      setI(0);
      setActive(true);
    }, 700);
    return () => clearTimeout(t);
  }, []);

  const finish = useCallback(() => {
    tokenRef.current++;
    setActive(false);
    setRect(null);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch (_) {}
  }, []);

  const start = useCallback(() => {
    setI(0);
    setActive(true);
  }, []);

  // Show the current step: switch mode, run its setup, wait for the anchor to
  // exist (mode switches remount an editor), then measure it.
  useEffect(() => {
    if (!active) return;
    const s = STEPS[i];
    const myToken = ++tokenRef.current;

    if (s.final) {
      setRect(null);
      return;
    }
    if (s.mode && useAppStore.getState().mode !== s.mode) {
      useAppStore.getState().setMode(s.mode);
    }

    let raf = 0;
    let tries = 0;
    let didBefore = false;
    const tick = () => {
      if (tokenRef.current !== myToken) return;
      if (!didBefore) {
        s.before?.();
        didBefore = true;
      }
      const el = document.querySelector(s.target);
      if (el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        raf = requestAnimationFrame(() => {
          if (tokenRef.current !== myToken) return;
          setRect(el.getBoundingClientRect());
        });
        return;
      }
      if (++tries > 120) {
        finish(); // anchor never appeared — bail rather than hang
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, i, finish]);

  // Keep the spotlight glued to its target through resize / inner-panel scroll.
  useEffect(() => {
    if (!active || STEPS[i].final) return;
    const sel = STEPS[i].target;
    const remeasure = () => {
      const el = document.querySelector(sel);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [active, i]);

  // Place the card off the target (or centered for the final card), clamped
  // to the viewport. Runs after the card renders so we know its real size.
  useLayoutEffect(() => {
    if (!active) return;
    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (STEPS[i].final || !rect) {
      setPos({ top: Math.max(12, (vh - ch) / 2), left: Math.max(12, (vw - cw) / 2) });
      return;
    }
    const gap = 14;
    const pl = STEPS[i].placement || "right";
    let top;
    let left;
    if (pl === "right") {
      left = rect.right + gap;
      top = rect.top;
    } else if (pl === "left") {
      left = rect.left - gap - cw;
      top = rect.top;
    } else if (pl === "bottom") {
      left = rect.left;
      top = rect.bottom + gap;
    } else {
      left = rect.left;
      top = rect.top - gap - ch;
    }
    left = Math.max(12, Math.min(left, vw - cw - 12));
    top = Math.max(12, Math.min(top, vh - ch - 12));
    setPos({ top, left });
  }, [active, i, rect]);

  if (!active) {
    if (hasToken) return null;
    return (
      <button className="tour-replay" onClick={start} title="Replay the walkthrough">
        ◉ Take the tour
      </button>
    );
  }

  const s = STEPS[i];
  const spotlight = rect && !s.final;

  return (
    <div className="tour-root">
      <div className={`tour-block${spotlight ? "" : " dim"}`} />
      {spotlight && (
        <div
          className="tour-hole"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div className="tour-card" ref={cardRef} style={{ top: pos.top, left: pos.left }}>
        <div className="tour-eyebrow">
          {s.final ? "You're all set" : `Step ${i + 1} of ${ANCHORED}`}
        </div>
        <h4>{s.title}</h4>
        <p>{s.body}</p>
        <div className="tour-actions">
          {!s.final && (
            <div className="tour-dots" aria-hidden="true">
              {STEPS.filter((x) => !x.final).map((_, d) => (
                <span key={d} className={`tour-dot${d === i ? " on" : ""}`} />
              ))}
            </div>
          )}
          <span className="spacer" />
          {s.final ? (
            <button className="tour-btn primary" onClick={finish}>
              Start building
            </button>
          ) : (
            <>
              <button className="tour-skip" onClick={finish}>
                Skip
              </button>
              <button
                className="tour-btn"
                onClick={() => setI((n) => Math.max(0, n - 1))}
                disabled={i === 0}
              >
                Back
              </button>
              <button className="tour-btn primary" onClick={() => setI((n) => n + 1)}>
                Next
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
