import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Square, Archive, X, Download, RotateCcw, ChevronLeft, Loader2 } from "lucide-react";

import { listTopics, topicCount, getTopic, randomIndexEntry } from "./services/topicRepository.js";
import {
  saveEntry,
  allEntries,
  nextAttemptNumber,
  dueReturns,
  exportArchive,
} from "./services/archiveStore.js";
import { createRecorder } from "./services/recorder.js";
import { requestFeedback, AI_ENABLED } from "./services/aiClient.js";

/* ============================================================
   Curio

   Loop:  Encounter → Commit → Research → Explain → Preserve → Return

   Two rules this file exists to enforce:
     1. The user produces before they receive. No answer renders before a
        prediction has been recorded.
     2. `briefing` is a reveal, not an input. It is unreachable during
        Research unless the user deliberately asks for it, and that request
        is recorded on the entry.
   ============================================================ */

const THEMES = {
  dark: {
    bg: "radial-gradient(120% 90% at 50% 0%, #24323F 0%, #171F27 55%, #121820 100%)",
    flat: "#171F27",
    surface: "#1B242E",
    surfaceAlt: "#212C37",
    text: "#EDE7DA",
    muted: "#96A2AC",
    line: "rgba(237,231,218,0.14)",
    accent: "#5AAE9F",
    amber: "#E3AC55",
    onAccent: "#10181E",
  },
  light: {
    bg: "radial-gradient(120% 90% at 50% 0%, #FBF8F0 0%, #F3EFE4 55%, #EDE8DA 100%)",
    flat: "#F3EFE4",
    surface: "#FFFDF7",
    surfaceAlt: "#F6F2E7",
    text: "#1D262E",
    muted: "#5E6A73",
    line: "rgba(29,38,46,0.14)",
    accent: "#2C7D70",
    amber: "#8A6015",
    onAccent: "#FFFFFF",
  },
};

const MODES = {
  cuff: { label: "Off the cuff", seconds: 0, sub: "Guess, then explain. No research." },
  deep: { label: "Deep dive", seconds: 900, sub: "Guess, research it yourself, then explain." },
};

const FILLERS = ["um", "uh", "like", "you know", "so yeah", "basically", "actually"];

const SLOT_H = 84;
const REEL_LEN = 30;
const FINAL_IDX = REEL_LEN - 2;
const LAND_Y = (FINAL_IDX - 1) * SLOT_H;

const fmt = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function tone(freqs, vol = 0.06, dur = 0.09) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.07;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    });
  } catch (e) {
    /* decorative only */
  }
}

export default function Curio() {
  /* ---------- presentation ---------- */
  const [themeName, setThemeName] = useState("dark");
  const t = THEMES[themeName];

  /* ---------- session ---------- */
  const [phase, setPhase] = useState("idle");
  const [mode, setMode] = useState("deep");
  const [topic, setTopic] = useState(null);
  const [prevTopicId, setPrevTopicId] = useState(null);
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [priorEntry, setPriorEntry] = useState(null);

  /* ---------- reel ---------- */
  const [spinning, setSpinning] = useState(false);
  const [reelItems, setReelItems] = useState([]);
  const [reelY, setReelY] = useState(0);
  const [reelAnim, setReelAnim] = useState(false);
  const [landed, setLanded] = useState(false);

  /* ---------- commit ---------- */
  const [prediction, setPrediction] = useState(null);
  const [liveTranscript, setLiveTranscript] = useState("");

  /* ---------- research ---------- */
  const [timeLeft, setTimeLeft] = useState(MODES.deep.seconds);
  const [revealedEarly, setRevealedEarly] = useState(false);

  /* ---------- explain ---------- */
  const [explanation, setExplanation] = useState(null);
  const [speakStart, setSpeakStart] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState(false);
  const [recording, setRecording] = useState(false);

  /* ---------- reveal ---------- */
  const [feedback, setFeedback] = useState(null);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError, setFbError] = useState(false);

  /* ---------- archive ---------- */
  const [entries, setEntries] = useState([]);
  const [showArchive, setShowArchive] = useState(false);
  const [returnIds, setReturnIds] = useState([]);
  const [saving, setSaving] = useState(false);

  const timerRef = useRef(null);
  const tickRef = useRef(null);
  const recorderRef = useRef(null);
  const urlsRef = useRef([]);

  const objectUrl = useCallback((blob) => {
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urlsRef.current.push(u);
    return u;
  }, []);

  /* ---------- load archive on mount ---------- */
  useEffect(() => {
    (async () => {
      try {
        setEntries(await allEntries());
        setReturnIds(await dueReturns());
      } catch (e) {
        /* archive unavailable; session still works */
      }
    })();
  }, []);

  /* ---------- research countdown ---------- */
  useEffect(() => {
    if (phase !== "research") return undefined;
    timerRef.current = setInterval(() => {
      setTimeLeft((x) => {
        if (x <= 1) {
          clearInterval(timerRef.current);
          setPhase("ready");
          return 0;
        }
        return x - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [phase]);

  /* ---------- teardown ---------- */
  useEffect(
    () => () => {
      clearInterval(tickRef.current);
      clearInterval(timerRef.current);
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    []
  );

  function resetSession() {
    setPhase("idle");
    setPrediction(null);
    setExplanation(null);
    setLiveTranscript("");
    setFeedback(null);
    setFbError(false);
    setRevealedEarly(false);
    setLanded(false);
    setElapsed(0);
    setMicError(false);
    setRecording(false);
    setPriorEntry(null);
  }

  /* ================= ENCOUNTER ================= */

  async function spin() {
    if (topic) setPrevTopicId(topic.id);
    resetSession();
    setTopic(null);

    // Prefer a topic due for return; otherwise draw fresh.
    const target =
      returnIds.length && Math.random() < 0.35
        ? { id: returnIds[Math.floor(Math.random() * returnIds.length)] }
        : randomIndexEntry(prevTopicId ? [prevTopicId] : []);

    const index = listTopics();
    const reel = Array.from({ length: REEL_LEN }, () => index[Math.floor(Math.random() * index.length)]);
    const finalEntry = index.find((x) => x.id === target.id) || reel[FINAL_IDX];
    reel[FINAL_IDX] = finalEntry;

    setReelItems(reel);
    setReelAnim(false);
    setReelY(0);
    setSpinning(true);

    let n = 0;
    clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      tone([600], 0.03, 0.045);
      n += 1;
      if (n > 22) clearInterval(tickRef.current);
    }, 100);

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setReelAnim(true);
        setReelY(-LAND_Y);
      })
    );
  }

  async function onReelEnd() {
    if (!spinning) return;
    clearInterval(tickRef.current);
    const chosen = reelItems[FINAL_IDX];
    setSpinning(false);
    setReelAnim(false);
    setReelY(0);

    try {
      const full = await getTopic(chosen.id);
      setTopic(full);
      const n = await nextAttemptNumber(full.id).catch(() => 1);
      setAttemptNumber(n);
      if (n > 1) {
        const all = await allEntries();
        setPriorEntry(all.find((e) => e.topic_id === full.id) || null);
      }
      setLanded(true);
      tone([392, 588], 0.085, 0.5);
    } catch (e) {
      setTopic(null);
    }
  }

  function goBack() {
    if (!prevTopicId) return;
    resetSession();
    getTopic(prevTopicId).then((full) => {
      setTopic(full);
      setPrevTopicId(null);
      setLanded(true);
    });
  }

  /* ================= RECORDING (shared) ================= */

  async function beginRecording() {
    setMicError(false);
    setLiveTranscript("");
    try {
      recorderRef.current = await createRecorder({ onTranscript: setLiveTranscript });
      recorderRef.current.start();
      setRecording(true);
      if (phase === "speak") setSpeakStart(Date.now());
      tone([523], 0.05, 0.12);
    } catch (e) {
      setMicError(true);
    }
  }

  async function endRecording() {
    if (!recorderRef.current) return null;
    const result = await recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
    tone([440], 0.05, 0.18);
    return result;
  }

  /* ================= COMMIT ================= */

  function startCommit() {
    setPhase("commit");
  }

  async function finishCommit() {
    const result = await endRecording();
    setPrediction(result);
    setLiveTranscript("");
    if (mode === "deep") {
      setTimeLeft(MODES.deep.seconds);
      setPhase("research");
    } else {
      setPhase("ready");
    }
  }

  /* ================= RESEARCH ================= */

  function revealBriefingEarly() {
    setRevealedEarly(true);
  }

  function finishResearch() {
    clearInterval(timerRef.current);
    setPhase("ready");
  }

  /* ================= EXPLAIN ================= */

  async function startExplaining() {
    setPhase("speak");
    setTimeout(beginRecording, 0);
  }

  async function finishExplaining() {
    const result = await endRecording();
    setExplanation(result);
    setElapsed(speakStart ? (Date.now() - speakStart) / 60000 : 0);
    setPhase("reveal");
  }

  function stats() {
    if (!explanation?.transcript) return null;
    const words = explanation.transcript.trim().split(/\s+/).filter(Boolean);
    const mins = Math.max(elapsed, 0.05);
    const low = explanation.transcript.toLowerCase();
    return {
      words: words.length,
      mins,
      wpm: Math.round(words.length / mins),
      fillers: FILLERS.reduce((s, f) => s + (low.split(f).length - 1), 0),
    };
  }

  /* ================= REVEAL ================= */

  async function getFeedbackNow() {
    if (!AI_ENABLED || !explanation?.transcript) return;
    setFbLoading(true);
    setFbError(false);
    try {
      setFeedback(
        await requestFeedback({
          topic,
          predictionTranscript: prediction?.transcript || "",
          explanationTranscript: explanation.transcript,
        })
      );
    } catch (e) {
      setFbError(true);
    }
    setFbLoading(false);
  }

  /* ================= PRESERVE ================= */

  async function save() {
    setSaving(true);
    try {
      await saveEntry({
        topic_id: topic.id,
        topic_title: topic.title,
        generation: topic.generation ?? 1,
        version: topic.version ?? 1,
        attempt_number: attemptNumber,
        created_at: new Date().toISOString(),
        mode,
        prediction: prediction || null,
        explanation: explanation || null,
        elapsed,
        revealed_early: revealedEarly,
        feedback: feedback || null,
      });
      setEntries(await allEntries());
      setReturnIds(await dueReturns());
    } catch (e) {
      /* keep the session usable even if persistence fails */
    }
    setSaving(false);
    resetSession();
    setTopic(null);
    setPrevTopicId(null);
  }

  async function downloadArchive() {
    const data = await exportArchive();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `curio-archive-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ================= STYLE HELPERS ================= */

  const base = {
    fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
    cursor: "pointer",
    minHeight: 48,
    transition: "opacity .18s, transform .12s, background .2s, border-color .2s",
  };
  const primary = { ...base, background: t.accent, color: t.onAccent, border: "none", borderRadius: 14, fontWeight: 700 };
  const ghost = { ...base, background: "transparent", color: t.text, border: `1px solid ${t.line}`, borderRadius: 14 };
  const eyebrow = { fontSize: 11.5, letterSpacing: ".2em", color: t.muted, fontWeight: 700 };
  const s = phase === "reveal" || phase === "done" ? stats() : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
        transition: "background .4s ease",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400&family=Atkinson+Hyperlegible:wght@400;700&display=swap');
        * { box-sizing: border-box; }
        .disp { font-family: 'Fraunces', Georgia, serif; }
        .tap:hover { opacity: .88; }
        .tap:active { transform: scale(.985); }
        .tap:focus-visible { outline: 3px solid ${t.amber}; outline-offset: 3px; }
        @keyframes settle { 0% { letter-spacing: .05em; opacity: 0; transform: translateY(8px); } 100% { letter-spacing: -.012em; opacity: 1; transform: translateY(0); } }
        .settle { animation: settle .75s cubic-bezier(.2,.8,.3,1) both; }
        @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .r1 { animation: rise .5s ease .10s both; }
        .r2 { animation: rise .5s ease .22s both; }
        .r3 { animation: rise .5s ease .34s both; }
        @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .42; } }
        .breathe { animation: breathe 1.7s ease-in-out infinite; }
        @keyframes spin360 { to { transform: rotate(360deg); } }
        .spin { animation: spin360 1s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .settle,.r1,.r2,.r3,.breathe,.spin { animation: none !important; } }
      `}</style>

      <div style={{ maxWidth: 520, margin: "0 auto", padding: "18px 20px 70px" }}>
        {/* ---------- masthead ---------- */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 30 }}>
          <div className="disp" style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.015em" }}>
            Curio
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="tap"
              aria-label="Switch theme"
              onClick={() => setThemeName(themeName === "dark" ? "light" : "dark")}
              style={{ ...ghost, minHeight: 40, borderRadius: 999, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            >
              {themeName === "dark" ? "☼" : "☾"}
            </button>
            <button
              className="tap"
              aria-label="Your archive"
              onClick={() => setShowArchive(true)}
              style={{ ...ghost, minHeight: 40, borderRadius: 999, padding: "0 15px", display: "flex", alignItems: "center", gap: 7, fontSize: 14 }}
            >
              <Archive size={15} /> {entries.length}
            </button>
          </div>
        </div>

        {/* ================= IDLE ================= */}
        {!topic && !spinning && (
          <div className="r1">
            <div style={{ display: "flex", background: t.surfaceAlt, border: `1px solid ${t.line}`, borderRadius: 999, padding: 4, gap: 4, marginBottom: 12 }}>
              {Object.entries(MODES).map(([k, m]) => (
                <button
                  key={k}
                  className="tap"
                  onClick={() => setMode(k)}
                  style={{ ...base, flex: 1, minHeight: 44, borderRadius: 999, border: "none", background: mode === k ? t.accent : "transparent", color: mode === k ? t.onAccent : t.muted, fontSize: 14.5, fontWeight: 700 }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 14, color: t.muted, textAlign: "center", marginBottom: 28 }}>
              {MODES[mode].sub}
            </div>

            <button className="tap" onClick={spin} style={{ ...primary, width: "100%", padding: "26px 20px", fontSize: 17 }}>
              Draw today's discovery
            </button>

            <div style={{ textAlign: "center", fontSize: 12.5, color: t.muted, marginTop: 16 }}>
              {topicCount()} topics
              {returnIds.length > 0 && ` · ${returnIds.length} ready to revisit`}
            </div>
          </div>
        )}

        {/* ================= REEL ================= */}
        {spinning && (
          <div>
            <div style={{ ...eyebrow, textAlign: "center", color: t.amber, marginBottom: 20 }}>DRAWING</div>
            <div style={{ position: "relative", height: SLOT_H * 3, overflow: "hidden" }}>
              <div style={{ position: "absolute", top: SLOT_H, left: 0, right: 0, height: SLOT_H, borderTop: `1px solid ${t.accent}66`, borderBottom: `1px solid ${t.accent}66`, zIndex: 3, pointerEvents: "none" }} />
              <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none", background: `linear-gradient(180deg, ${t.flat} 0%, ${t.flat}00 30%, ${t.flat}00 70%, ${t.flat} 100%)` }} />
              <div onTransitionEnd={onReelEnd} style={{ transform: `translateY(${reelY}px)`, transition: reelAnim ? "transform 3.1s cubic-bezier(.06,.7,.14,1)" : "none" }}>
                {reelItems.map((x, i) => (
                  <div key={`${x.id}-${i}`} style={{ height: SLOT_H, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 14px" }}>
                    <span className="disp" style={{ fontSize: 24, fontWeight: 500, textAlign: "center", lineHeight: 1.1 }}>{x.title}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ================= TOPIC ================= */}
        {topic && !spinning && (
          <div>
            {/* ---------- ENCOUNTER: title + hook only ---------- */}
            <div className="r1" style={{ ...eyebrow, textAlign: "center", color: t.amber, marginBottom: 18 }}>
              {attemptNumber > 1 ? `YOU MET THIS BEFORE · ATTEMPT ${attemptNumber}` : "TODAY'S DISCOVERY"}
            </div>

            <h1 className={`disp ${landed ? "settle" : ""}`} style={{ textAlign: "center", fontSize: 41, fontWeight: 500, lineHeight: 1.07, margin: "0 0 18px" }}>
              {topic.title}
            </h1>

            {phase !== "speak" && (
              <p className="r2" style={{ textAlign: "center", fontSize: 17, color: t.muted, lineHeight: 1.62, maxWidth: 400, margin: "0 auto 34px" }}>
                {topic.hook}
              </p>
            )}

            {/* ---------- IDLE ACTIONS ---------- */}
            {phase === "idle" && (
              <div className="r3">
                <button className="tap" onClick={startCommit} style={{ ...primary, width: "100%", padding: 17, fontSize: 16, marginBottom: 10 }}>
                  Make your guess
                </button>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={spin} style={{ ...ghost, flex: 1, padding: 14, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Draw another
                  </button>
                  {prevTopicId && (
                    <button className="tap" onClick={goBack} style={{ ...ghost, padding: "14px 18px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <ChevronLeft size={15} /> Back
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ---------- COMMIT ---------- */}
            {phase === "commit" && (
              <div className="r1">
                <div style={{ ...eyebrow, marginBottom: 10 }}>YOUR GUESS</div>
                <p className="disp" style={{ fontSize: 20, lineHeight: 1.5, margin: "0 0 24px" }}>
                  {topic.prediction_prompt}
                </p>

                {micError ? (
                  <div style={{ fontSize: 15, color: t.amber, textAlign: "center", lineHeight: 1.55, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16 }}>
                    Recording needs microphone access. Allow it in your browser settings, then try again.
                  </div>
                ) : !recording ? (
                  <button className="tap" onClick={beginRecording} style={{ ...primary, width: "100%", padding: 18, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
                    <Mic size={17} /> Record your guess
                  </button>
                ) : (
                  <div style={{ textAlign: "center" }}>
                    <div className="breathe" style={{ ...eyebrow, color: t.amber, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.amber }} /> RECORDING
                    </div>
                    {liveTranscript && (
                      <div style={{ fontSize: 15, color: t.muted, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 15, marginBottom: 18, textAlign: "left", maxHeight: 120, overflowY: "auto", lineHeight: 1.6 }}>
                        {liveTranscript}
                      </div>
                    )}
                    <button className="tap" onClick={finishCommit} aria-label="Finish guess" style={{ ...base, background: t.text, color: t.flat, border: "none", borderRadius: "50%", width: 70, height: 70, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <Square size={21} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ---------- RESEARCH: reference_material only ---------- */}
            {phase === "research" && (
              <div className="r1">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
                  <span style={eyebrow}>RESEARCH IT YOURSELF</span>
                  <span className="disp" style={{ fontSize: 26, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmt(timeLeft)}</span>
                </div>

                {topic.reference_material?.names?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>NAMES</div>
                    <div style={{ fontSize: 15.5, lineHeight: 1.7 }}>{topic.reference_material.names.join(" · ")}</div>
                  </div>
                )}

                {topic.reference_material?.timeline?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>WHEN</div>
                    {topic.reference_material.timeline.map((d, i) => (
                      <div key={i} style={{ fontSize: 15.5, lineHeight: 1.7 }}>{d}</div>
                    ))}
                  </div>
                )}

                {topic.reference_material?.terms?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>TERMS TO LOOK UP</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {topic.reference_material.terms.map((w, i) => (
                        <span key={i} style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 999, padding: "7px 14px", fontSize: 14.5 }}>{w}</span>
                      ))}
                    </div>
                  </div>
                )}

                {topic.reference_material?.research_threads?.length > 0 && (
                  <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16, marginBottom: 26 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>FOLLOW THESE</div>
                    {topic.reference_material.research_threads.map((q, i) => (
                      <p key={i} className="disp" style={{ fontSize: 17, lineHeight: 1.5, margin: "0 0 10px", fontStyle: "italic" }}>{q}</p>
                    ))}
                  </div>
                )}

                {revealedEarly && (
                  <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>BRIEFING (REVEALED EARLY)</div>
                    <p style={{ fontSize: 15.5, lineHeight: 1.65, margin: 0 }}>{topic.briefing}</p>
                  </div>
                )}

                <button className="tap" onClick={finishResearch} style={{ ...primary, width: "100%", padding: 17, fontSize: 16, marginBottom: 10 }}>
                  I'm ready to explain
                </button>

                {!revealedEarly && (
                  <button className="tap" onClick={revealBriefingEarly} style={{ ...ghost, width: "100%", padding: 13, fontSize: 13.5, color: t.muted }}>
                    I'm stuck — show me the briefing
                  </button>
                )}
              </div>
            )}

            {/* ---------- READY ---------- */}
            {phase === "ready" && (
              <div className="r1">
                <button className="tap" onClick={startExplaining} style={{ ...primary, width: "100%", padding: 18, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
                  <Mic size={17} /> Explain it in your own words
                </button>
                {mode === "deep" && (
                  <button className="tap" onClick={() => setPhase("research")} style={{ ...ghost, width: "100%", padding: 13, fontSize: 14 }}>
                    Back to research
                  </button>
                )}
              </div>
            )}

            {/* ---------- EXPLAIN ---------- */}
            {phase === "speak" && (
              <div style={{ textAlign: "center" }}>
                {micError ? (
                  <div style={{ fontSize: 15, color: t.amber, lineHeight: 1.55, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16 }}>
                    Recording needs microphone access. Allow it, then try again.
                  </div>
                ) : (
                  <>
                    <div className="breathe" style={{ ...eyebrow, color: t.amber, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.amber }} /> RECORDING
                    </div>
                    {liveTranscript && (
                      <div style={{ fontSize: 15, color: t.muted, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 15, marginBottom: 18, textAlign: "left", maxHeight: 140, overflowY: "auto", lineHeight: 1.6 }}>
                        {liveTranscript}
                      </div>
                    )}
                    <button className="tap" onClick={finishExplaining} aria-label="Stop recording" style={{ ...base, background: t.text, color: t.flat, border: "none", borderRadius: "50%", width: 70, height: 70, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <Square size={21} />
                    </button>
                  </>
                )}
              </div>
            )}

            {/* ---------- REVEAL ---------- */}
            {phase === "reveal" && (
              <div className="r1">
                {s && (
                  <p className="disp" style={{ fontSize: 20, lineHeight: 1.45, margin: "0 0 22px", textAlign: "center", fontWeight: 500 }}>
                    You spoke for {s.mins < 1 ? `${Math.round(s.mins * 60)} seconds` : `${s.mins.toFixed(1)} minutes`}.
                  </p>
                )}

                <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.amber}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                  <div style={{ ...eyebrow, marginBottom: 8 }}>MOST PEOPLE THINK</div>
                  <p style={{ fontSize: 15.5, lineHeight: 1.6, margin: 0 }}>{topic.misconception}</p>
                </div>

                <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.accent}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                  <div style={{ ...eyebrow, marginBottom: 8 }}>WHAT IS ACTUALLY KNOWN</div>
                  <p style={{ fontSize: 15.5, lineHeight: 1.65, margin: 0 }}>{topic.briefing}</p>
                </div>

                {prediction?.blob && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>YOUR GUESS</div>
                    <audio controls src={objectUrl(prediction.blob)} style={{ width: "100%", height: 38 }} />
                  </div>
                )}
                {explanation?.blob && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>YOUR EXPLANATION</div>
                    <audio controls src={objectUrl(explanation.blob)} style={{ width: "100%", height: 38 }} />
                  </div>
                )}

                {priorEntry?.explanation?.blob && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>
                      {new Date(priorEntry.created_at).toLocaleDateString()} — WHAT YOU SAID LAST TIME
                    </div>
                    <audio controls src={objectUrl(priorEntry.explanation.blob)} style={{ width: "100%", height: 38 }} />
                  </div>
                )}

                {AI_ENABLED && !feedback && !fbLoading && explanation?.transcript && (
                  <button className="tap" onClick={getFeedbackNow} style={{ ...ghost, width: "100%", padding: 14, fontSize: 14.5, marginBottom: 14, color: t.amber, borderStyle: "dashed" }}>
                    How did I do?
                  </button>
                )}
                {fbLoading && (
                  <div className="breathe" style={{ textAlign: "center", fontSize: 15, color: t.amber, fontWeight: 700, marginBottom: 14 }}>
                    Listening closely…
                  </div>
                )}
                {fbError && (
                  <div style={{ fontSize: 14.5, color: t.amber, textAlign: "center", marginBottom: 14 }}>
                    Feedback didn't load.
                  </div>
                )}
                {feedback && (
                  <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                    {feedback.encouragement && (
                      <p className="disp" style={{ fontSize: 17, lineHeight: 1.55, margin: "0 0 12px" }}>{feedback.encouragement}</p>
                    )}
                    {feedback.understanding && (
                      <>
                        <div className="disp" style={{ fontSize: 16, fontWeight: 600, color: t.accent, marginBottom: 6 }}>{feedback.understanding.verdict}</div>
                        <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 10px" }}>{feedback.understanding.detail}</p>
                      </>
                    )}
                    {feedback.missed?.map((m, i) => (
                      <div key={i} style={{ fontSize: 14.5, color: t.muted, marginTop: 6, paddingLeft: 14, position: "relative", lineHeight: 1.55 }}>
                        <span style={{ position: "absolute", left: 0, color: t.accent }}>—</span> {m}
                      </div>
                    ))}
                    {feedback.next_time && (
                      <p style={{ fontSize: 15, lineHeight: 1.6, margin: "12px 0 0", color: t.muted }}>{feedback.next_time}</p>
                    )}
                  </div>
                )}

                {topic.discussion_prompt && (
                  <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16, marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>THINK ABOUT</div>
                    <p className="disp" style={{ fontSize: 18, lineHeight: 1.45, margin: 0, fontStyle: "italic" }}>{topic.discussion_prompt}</p>
                  </div>
                )}

                {s && (
                  <p style={{ fontSize: 14, color: t.muted, textAlign: "center", marginBottom: 16 }}>
                    {s.words} words · {s.wpm} per minute · {s.fillers} filler{s.fillers === 1 ? "" : "s"}
                  </p>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={save} disabled={saving} style={{ ...primary, flex: 1, padding: 15, fontSize: 15.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {saving && <Loader2 size={15} className="spin" />} Save entry
                  </button>
                  <button className="tap" onClick={spin} style={{ ...ghost, padding: "15px 20px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Another
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= ARCHIVE ================= */}
      {showArchive && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(8,12,16,.6)", display: "flex", justifyContent: "flex-end", zIndex: 60 }} onClick={() => setShowArchive(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(380px,90vw)", height: "100%", background: t.flat, padding: 22, overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div className="disp" style={{ fontSize: 21, fontWeight: 600 }}>Your archive</div>
              <button className="tap" onClick={() => setShowArchive(false)} aria-label="Close" style={{ ...ghost, minHeight: 40, borderRadius: 999, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <X size={16} />
              </button>
            </div>

            {entries.length > 0 && (
              <button className="tap" onClick={downloadArchive} style={{ ...ghost, width: "100%", padding: 12, fontSize: 14, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Download size={15} /> Export everything
              </button>
            )}

            {entries.length === 0 && (
              <p style={{ fontSize: 15, color: t.muted, lineHeight: 1.6 }}>
                Nothing saved yet. Draw a discovery and record your first entry.
              </p>
            )}

            {entries.map((e) => (
              <div key={e.id} style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>{e.topic_title}</div>
                <div style={{ fontSize: 12.5, color: t.muted, marginTop: 4 }}>
                  {new Date(e.created_at).toLocaleString()} · {MODES[e.mode]?.label || e.mode}
                  {e.attempt_number > 1 && ` · attempt ${e.attempt_number}`}
                </div>
                {e.explanation?.blob && (
                  <audio controls src={objectUrl(e.explanation.blob)} style={{ width: "100%", marginTop: 10, height: 36 }} />
                )}
                {e.revealed_early && (
                  <div style={{ fontSize: 12, color: t.muted, marginTop: 8, fontStyle: "italic" }}>briefing revealed early</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
