import { useState, useRef, useEffect, useCallback } from "react";
import {
  Mic, Square, Archive, X, Download, RotateCcw, ChevronLeft, Sparkles, Sun, Moon, Trash2,
} from "lucide-react";

import { getCatalogue, loadTopic, pickRandomId, reelTitles } from "./services/topicLoader";
import {
  saveEntry, listEntries, getDueReturns, previousAttempt, attemptCountFor,
  deleteEntry, exportArchive, downloadBlob,
} from "./services/archive";
import { requestFeedback, aiAvailable } from "./services/ai";

/* ============================================================
   Curio

   Loop:  Encounter → Commit → Research → Explain → Preserve → Return

   Constitutional invariants enforced here:
   1. Nothing from `briefing` or `misconception` reaches the screen
      before an explanation exists, unless the user explicitly asks
      (recorded as revealed_early).
   2. `reference_material` is the only research input.
   3. Categories are never user-facing.
   4. No scores, no streaks, no overdue state.
   ============================================================ */

/* ============================================================
   Asset configuration — the only place image/audio paths live.
   Every path is a placeholder; the caller replaces them later.
   Missing files degrade silently: the gradient environment renders
   and the existing synthesised tones play.
   ============================================================ */
const CURIO_ASSETS = {
  home: {
    desktop: "/assets/curio/home-jungle-cave-desktop.webp",
    mobile: "/assets/curio/home-jungle-cave-mobile.webp",
  },
  rolling: {
    desktop: "/assets/curio/topic-roll-jungle-desktop.webp",
    mobile: "/assets/curio/topic-roll-jungle-mobile.webp",
  },
  knowledgeBook: {
    desktop: "/assets/curio/knowledge-book-desktop.webp",
    mobile: "/assets/curio/knowledge-book-mobile.webp",
  },
  sounds: {
    topicRoll: "/assets/curio/topic-roll.mp3",
    topicLand: "/assets/curio/topic-land.mp3",
  },
};

const BREAKPOINT_MOBILE = 768;

const THEMES = {
  dark: {
    // forest floor at dusk — deep green over charcoal
    bg: "radial-gradient(130% 100% at 50% 0%, #1D2B24 0%, #141C18 52%, #0D1310 100%)",
    flat: "#141C18",
    surface: "#1C2620",
    surfaceAlt: "#222E27",
    text: "#EFE8D8",        // warm parchment
    muted: "#9AA79E",       // muted stone
    line: "rgba(239,232,216,0.14)",
    accent: "#5FA98C",      // forest verdigris
    amber: "#D9A441",       // antique gold — discovery
    onAccent: "#0D1310",
    scrimTop: "rgba(13,19,16,0.22)",
    scrimBottom: "rgba(13,19,16,0.86)",
    focal: "rgba(95,169,140,0.13)",      // soft atmospheric depth behind the reel
    vignette: "rgba(6,10,8,0.62)",       // corners recede
    glint: "#F2CE86",                    // light catching polished antique gold
  },
  light: {
    // parchment and moss
    bg: "radial-gradient(130% 100% at 50% 0%, #F7F3E7 0%, #EFEADB 55%, #E6E0CE 100%)",
    flat: "#EFEADB",
    surface: "#FFFDF6",
    surfaceAlt: "#F5F0E1",
    text: "#1B241F",        // charcoal
    muted: "#55635B",
    line: "rgba(27,36,31,0.15)",
    accent: "#2C6B54",      // deep forest
    amber: "#8A6218",       // warm bronze
    onAccent: "#FFFDF6",
    scrimTop: "rgba(239,234,219,0.28)",
    scrimBottom: "rgba(239,234,219,0.88)",
    focal: "rgba(44,107,84,0.10)",
    vignette: "rgba(120,110,88,0.30)",
    glint: "#B98A2E",
  },
};

const MODES = {
  cuff: { label: "Off the cuff", seconds: 120, sub: "Guess, then explain. No research." },
  deep: { label: "Deep dive", seconds: 900, sub: "Guess, research it yourself, then explain." },
};

const REEL_LEN = 30;
const FINAL_IDX = REEL_LEN - 2;

/* Reel geometry scales with the viewport. LAND_Y is always derived from the
   slot height in use, so the chosen term stays centred at every size. */
/* ============================================================
   Reel geometry

   One number governs everything: slotH. From it,
     --c-slot  -> .curio-reel (3 slots), .curio-reel__window, .curio-reel__slot
     LAND_Y    -> (FINAL_IDX - 1) * slotH, the animation target
   so item FINAL_IDX always lands at offset exactly slotH: the centre slot.

   Width sets the intended scale; the height actually available on the
   drawing screen caps it. The cap is derived from the vertical values in
   index.css rather than estimated.
   ============================================================ */

/* Anchor points mirroring the desktop breakpoints in index.css.
   Interpolated between, so there is no discontinuity at any width. */
const SLOT_ANCHORS = [
  [768, 92],    // tablet — current value, preserved
  [1024, 150],
  [1280, 180],
  [1440, 210],
  [1920, 235],
  [2560, 250],
];

/* Floor of last resort. The height cap is allowed to go below the tablet
   anchor on very short screens — claiming a larger slot "fits" when it does
   not is worse than a small reel. */
const ABSOLUTE_MIN_SLOT = 56;

/* index.css: @media (max-height: 620px) */
const SHORT_VIEWPORT_H = 620;

function cssClamp(min, preferred, max) {
  return Math.max(min, Math.min(preferred, max));
}

function slotByWidth(width) {
  const first = SLOT_ANCHORS[0];
  const last = SLOT_ANCHORS[SLOT_ANCHORS.length - 1];
  if (width <= first[0]) return first[1];
  if (width >= last[0]) return last[1];
  for (let i = 1; i < SLOT_ANCHORS.length; i += 1) {
    const [w0, s0] = SLOT_ANCHORS[i - 1];
    const [w1, s1] = SLOT_ANCHORS[i];
    if (width <= w1) return s0 + ((width - w0) / (w1 - w0)) * (s1 - s0);
  }
  return last[1];
}

/* Everything on the drawing screen except the reel itself. Each term mirrors
   a real declaration in index.css, so the model tracks the stylesheet:
     .curio-shell   padding-top (per breakpoint) + padding-bottom 56px
     .curio-masthead  control row height + margin-bottom
     .curio-eyebrow   label line + margin-bottom
     .curio-canvas    padding-bottom 5vh
*/
function desktopChrome(width, height) {
  const vh = height / 100;
  const short = height <= SHORT_VIEWPORT_H;   // @media (max-height: 620px)

  let shellPadTop;
  let controlRow;
  if (width >= 1920)      { shellPadTop = cssClamp(36, 3.8 * vh, 60); controlRow = 48; }
  else if (width >= 1440) { shellPadTop = cssClamp(32, 3.5 * vh, 52); controlRow = 48; }
  else if (width >= 1280) { shellPadTop = cssClamp(28, 3.2 * vh, 46); controlRow = 46; }
  else                    { shellPadTop = cssClamp(24, 3.0 * vh, 40); controlRow = 44; }

  // .curio-masthead margin-bottom — the short-height rule overrides the clamp
  const mastheadGap = short ? 18 : cssClamp(40, 6 * vh, 72);

  // .curio-eyebrow: font-size 11.5px x line-height 1.6, plus its margin-bottom
  const eyebrowLine  = 11.5 * 1.6;
  const eyebrowBlock = eyebrowLine + cssClamp(14, 3 * vh, 20);

  // .curio-shell padding-bottom: 56px, or 40px under the short-height rule
  const shellPadBot = short ? 40 : 56;

  // .curio-canvas padding-bottom: 5vh, or 0 under the short-height rule
  const canvasPadBot = short ? 0 : 5 * vh;

  return shellPadTop + controlRow + mastheadGap + eyebrowBlock + shellPadBot + canvasPadBot;
}

function slotHeightFor(width, height) {
  // Mobile — deliberately unchanged.
  if (width < 360) return 64;
  if (width < BREAKPOINT_MOBILE) return 72;

  const byWidth = slotByWidth(width);
  const byHeight = (height - desktopChrome(width, height)) / 3;

  // floor, not round: guarantees 3 * slotH <= available reel space
  const fitted = Math.floor(Math.min(byWidth, byHeight));
  return Math.max(ABSOLUTE_MIN_SLOT, fitted);
}

function useViewport(frozen) {
  const [vp, setVp] = useState(() =>
    typeof window === "undefined"
      ? { w: 1280, h: 900 }
      : { w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    if (frozen) return undefined;            // never resize mid-spin
    const onResize = () =>
      setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [frozen]);
  return {
    isMobile: vp.w < BREAKPOINT_MOBILE,
    slotH: slotHeightFor(vp.w, vp.h),
  };
}

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
  } catch (e) { /* decorative */ }
}

/* Sound assets are placeholders. If a file is absent, blocked, or autoplay
   is refused, this returns null and the caller falls back to tone(). */
function playClip(src, { loop = false } = {}) {
  try {
    const el = new Audio(src);
    el.loop = loop;
    el.volume = 0.35;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return el;
  } catch (e) {
    return null;
  }
}

function stopClip(el) {
  try { el?.pause(); if (el) el.currentTime = 0; } catch (e) { /* already gone */ }
}

/* ============================================================
   BackgroundStage — the environment behind the experience.

   <picture> gives true art direction: a different crop on mobile, so the
   cave mouth and the illuminated book are never cropped away. onError
   removes the image layer; the gradient beneath is a complete design on
   its own, so a missing asset is invisible rather than broken.

   "quiet" stages render no artwork — the user has stepped away to think.
   ============================================================ */
function BackgroundStage({ art, isMobile, quiet }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [art?.desktop]);

  const showArt = Boolean(art) && !quiet && !failed;

  return (
    <div className="curio-stage" data-art={showArt ? "on" : "off"} aria-hidden="true">
      <div className="curio-stage__base" />
      {showArt && (
        <picture>
          <source media={`(max-width: ${BREAKPOINT_MOBILE - 1}px)`} srcSet={art.mobile} />
          <img
            className="curio-stage__art"
            src={art.desktop}
            alt=""
            loading="eager"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </picture>
      )}
      {showArt && <div className="curio-stage__scrim" />}
    </div>
  );
}

/* ---------- recorder: one implementation, used twice ---------- */

function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const srRef = useRef(null);
  const resolveRef = useRef(null);
  const streamRef = useRef(null);

  const start = useCallback(async () => {
    setError(false);
    setTranscript("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        resolveRef.current?.(blob);
      };
      rec.start();
      recRef.current = rec;

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        const r = new SR();
        r.continuous = true;
        r.interimResults = true;
        r.lang = "en-US";
        let fin = "";
        r.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i += 1) {
            if (e.results[i].isFinal) fin += `${e.results[i][0].transcript} `;
            else interim += e.results[i][0].transcript;
          }
          setTranscript(fin + interim);
        };
        r.onerror = () => {};
        r.start();
        srRef.current = r;
      }
      setRecording(true);
      return true;
    } catch (e) {
      setError(true);
      return false;
    }
  }, []);

  const stop = useCallback(
    () =>
      new Promise((resolve) => {
        resolveRef.current = resolve;
        try {
          recRef.current?.stop();
          srRef.current?.stop();
        } catch (e) { resolve(null); }
        setRecording(false);
      }),
    []
  );

  const reset = useCallback(() => { setTranscript(""); setError(false); }, []);

  /* Hard stop. Discards the take and releases the microphone.
     Used when a session is abandoned — never produces a blob. */
  const abort = useCallback(() => {
    try { recRef.current?.stop(); } catch (e) { /* already inactive */ }
    try { srRef.current?.stop(); } catch (e) { /* already inactive */ }
    try { streamRef.current?.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* no stream */ }
    streamRef.current = null;
    resolveRef.current = null;
    chunksRef.current = [];
    setRecording(false);
    setTranscript("");
  }, []);

  return { recording, transcript, error, start, stop, reset, abort };
}

/* ============================================================ */

export default function Curio() {
  const [themeName, setThemeName] = useState("dark");
  const t = THEMES[themeName];

  // --- session ---
  const [phase, setPhase] = useState("idle");     // idle|commit|research|ready|speak|reveal|saved
  const [mode, setMode] = useState("deep");
  const [topic, setTopic] = useState(null);
  const [prevTopicId, setPrevTopicId] = useState(null);
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [seenIds, setSeenIds] = useState([]);

  // --- draw ---
  const [spinning, setSpinning] = useState(false);
  const [reelItems, setReelItems] = useState([]);
  const [reelY, setReelY] = useState(0);
  const [reelAnim, setReelAnim] = useState(false);
  const [landed, setLanded] = useState(false);
  const pendingIdRef = useRef(0);        // draw sequence in flight
  const pendingTopicIdRef = useRef(null);

  // --- commit / explain ---
  const [prediction, setPrediction] = useState({ blob: null, url: null, transcript: "" });
  const [explanation, setExplanation] = useState({ blob: null, url: null, transcript: "" });
  const [activeRecording, setActiveRecording] = useState(null); // "prediction" | "explanation"
  const recorder = useRecorder();

  // --- research ---
  const [timeLeft, setTimeLeft] = useState(MODES.deep.seconds);
  const [revealedEarly, setRevealedEarly] = useState(false);

  // --- reveal ---
  const [elapsed, setElapsed] = useState(0);
  const [priorEntry, setPriorEntry] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError, setFbError] = useState(false);

  // --- archive ---
  const [entries, setEntries] = useState([]);
  const [showArchive, setShowArchive] = useState(false);
  const [dueReturns, setDueReturns] = useState([]);
  const [entryUrls, setEntryUrls] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // --- navigation ---
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const { isMobile, slotH } = useViewport(spinning);

  /* A spin locks the geometry it started with. --c-slot and LAND_Y are both
     derived from `activeSlotH`, so the CSS the reel is rendered with and the
     transform it animates to can never come from different snapshots. */
  const [lockedSlotH, setLockedSlotH] = useState(null);
  const activeSlotH = lockedSlotH ?? slotH;
  const LAND_Y = (FINAL_IDX - 1) * activeSlotH;

  const timerRef = useRef(null);
  const tickRef = useRef(null);
  const rollAudioRef = useRef(null);
  const speakStartRef = useRef(null);
  const urlsRef = useRef([]);
  const spinningRef = useRef(false);   // synchronous mirror of `spinning`
  const drawSeqRef = useRef(0);        // invalidates an in-flight draw

  /* ---------- lifecycle ---------- */

  useEffect(() => {
    refreshArchive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* One object URL per saved entry, rebuilt only when the list changes.
     Creating these inline in render leaks a URL on every re-render. */
  useEffect(() => {
    const map = {};
    for (const e of entries) {
      if (e.explanation?.blob) map[e.id] = URL.createObjectURL(e.explanation.blob);
    }
    setEntryUrls(map);
    return () => Object.values(map).forEach((u) => URL.revokeObjectURL(u));
  }, [entries]);

  useEffect(() => {
    if (phase !== "research") return;
    timerRef.current = setInterval(() => {
      setTimeLeft((x) => {
        if (x <= 1) { clearInterval(timerRef.current); setPhase("ready"); return 0; }
        return x - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [phase]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearInterval(tickRef.current);
    stopClip(rollAudioRef.current);
    releaseSessionUrls();
  }, []);

  async function refreshArchive() {
    const [list, due] = await Promise.all([
      listEntries().catch(() => []),
      getDueReturns().catch(() => []),
    ]);
    setEntries(list);
    setDueReturns(due);
  }

  /* Reel sound. Asset first; synthesised ticks when the file is absent. */
  function startRollAudio() {
    clearInterval(tickRef.current);
    stopClip(rollAudioRef.current);
    rollAudioRef.current = playClip(CURIO_ASSETS.sounds.topicRoll, { loop: true });
    if (!rollAudioRef.current) {
      let n = 0;
      tickRef.current = setInterval(() => {
        tone([600], 0.03, 0.045);
        n += 1;
        if (n > 22) clearInterval(tickRef.current);
      }, 100);
    }
  }

  function stopRollAudio() {
    clearInterval(tickRef.current);
    stopClip(rollAudioRef.current);
    rollAudioRef.current = null;
  }

  /* Temporary session URLs for the prediction/explanation takes.
     Kept separate from entryUrls, which belong to persisted archive entries. */
  function trackUrl(blob) {
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  }

  function releaseUrl(url) {
    if (!url) return;
    URL.revokeObjectURL(url);
    urlsRef.current = urlsRef.current.filter((u) => u !== url);
  }

  function releaseSessionUrls() {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  }

  function resetSession() {
    releaseSessionUrls();
    setPhase("idle");
    setPrediction({ blob: null, url: null, transcript: "" });
    setExplanation({ blob: null, url: null, transcript: "" });
    setFeedback(null);
    setFbError(false);
    setRevealedEarly(false);
    setLanded(false);
    setElapsed(0);
    setPriorEntry(null);
    setActiveRecording(null);
    recorder.reset();
  }

  /* ---------- ENCOUNTER ---------- */

  function draw(targetId = null) {
    if (topic) setPrevTopicId(topic.id);
    resetSession();
    setTopic(null);

    const seq = ++drawSeqRef.current;   // any earlier draw is now void
    spinningRef.current = true;

    const finalId = targetId ?? pickRandomId(seenIds);
    pendingIdRef.current = seq;

    const reel = reelTitles(REEL_LEN);
    const catEntry = getCatalogue().find((x) => x.id === finalId);
    reel[FINAL_IDX] = { id: finalId, title: catEntry?.title ?? "" };

    // Snapshot the geometry this spin will use, read fresh from the viewport.
    const snapSlotH = typeof window === "undefined"
      ? activeSlotH
      : slotHeightFor(window.innerWidth, window.innerHeight);
    const snapLandY = (FINAL_IDX - 1) * snapSlotH;
    setLockedSlotH(snapSlotH);

    setReelItems(reel);
    setReelAnim(false);
    setReelY(0);
    setSpinning(true);
    pendingTopicIdRef.current = finalId;

    startRollAudio();

    // snapLandY comes from the same number written to --c-slot, so the
    // transform target cannot drift from the rendered slot height.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => { setReelAnim(true); setReelY(-snapLandY); })
    );
  }

  async function onReelEnd() {
    if (!spinningRef.current) return;        // abandoned mid-spin
    const seq = pendingIdRef.current;
    stopRollAudio();
    spinningRef.current = false;
    setSpinning(false);
    setReelAnim(false);
    setReelY(0);
    setLockedSlotH(null);          // geometry follows the viewport again

    const id = pendingTopicIdRef.current;
    try {
      const full = await loadTopic(id);
      const attempts = await attemptCountFor(id);
      if (drawSeqRef.current !== seq) return; // abandoned while loading
      setTopic(full);
      setAttemptNumber(attempts + 1);
      setSeenIds((s) => [...s, id]);
      setLanded(true);
      if (!playClip(CURIO_ASSETS.sounds.topicLand)) tone([392, 588], 0.085, 0.5);
    } catch (e) {
      setTopic(null);
    }
  }

  function goBack() {
    if (!prevTopicId) return;
    draw(prevTopicId);
    setPrevTopicId(null);
  }

  /* ---------- COMMIT ---------- */

  function beginCommit() {
    setPhase("commit");
  }

  async function startPrediction() {
    const ok = await recorder.start();
    if (ok) setActiveRecording("prediction");
  }

  async function stopPrediction() {
    const blob = await recorder.stop();
    releaseUrl(prediction.url);   // a re-record replaces the previous take
    const url = trackUrl(blob);
    setPrediction({ blob, url, transcript: recorder.transcript });
    setActiveRecording(null);
    tone([440], 0.05, 0.18);

    if (mode === "cuff") { setPhase("ready"); return; }
    setTimeLeft(MODES.deep.seconds);
    setPhase("research");
  }

  function skipPrediction() {
    releaseUrl(prediction.url);   // defensive: no path currently reaches
    setPrediction({ blob: null, url: null, transcript: "" });
    if (mode === "cuff") { setPhase("ready"); return; }
    setTimeLeft(MODES.deep.seconds);
    setPhase("research");
  }

  /* ---------- EXPLAIN ---------- */

  async function startExplanation() {
    recorder.reset();
    const ok = await recorder.start();
    if (ok) {
      setActiveRecording("explanation");
      speakStartRef.current = Date.now();
      setPhase("speak");
      tone([523], 0.05, 0.12);
    }
  }

  async function stopExplanation() {
    const blob = await recorder.stop();
    releaseUrl(explanation.url);  // a re-record replaces the previous take
    const url = trackUrl(blob);
    setExplanation({ blob, url, transcript: recorder.transcript });
    setElapsed(speakStartRef.current ? (Date.now() - speakStartRef.current) / 60000 : 0);
    setActiveRecording(null);
    tone([440], 0.05, 0.18);

    // Prior attempt is fetched now, revealed only on this screen — never before.
    if (attemptNumber > 1) {
      previousAttempt(topic.id).then(setPriorEntry).catch(() => {});
    }
    setPhase("reveal");
  }

  /* ---------- REVEAL ---------- */

  async function loadFeedback() {
    setFbLoading(true);
    setFbError(false);
    try {
      const fb = await requestFeedback({
        topic,
        predictionTranscript: prediction.transcript,
        explanationTranscript: explanation.transcript,
      });
      setFeedback(fb);
    } catch (e) {
      setFbError(true);
    }
    setFbLoading(false);
  }

  /* ---------- PRESERVE ---------- */

  async function preserve() {
    await saveEntry({
      topic_id: topic.id,
      topic_title: topic.title,
      generation: topic.generation ?? 1,
      version: topic.version ?? 1,
      attempt_number: attemptNumber,
      mode,
      elapsed_minutes: elapsed,
      revealed_early: revealedEarly,
      prediction: { blob: prediction.blob, transcript: prediction.transcript },
      explanation: { blob: explanation.blob, transcript: explanation.transcript },
      feedback,
    });
    await refreshArchive();
    resetSession();
    setTopic(null);
    setPrevTopicId(null);
    setPhase("saved");
  }

  /* ---------- HOME NAVIGATION ---------- */

  // The session begins the moment a discovery is initiated. The reel counts:
  // this is true while spinning, before a topic exists, and at phase "idle".
  const sessionInProgress = spinning || Boolean(topic);

  function goHome() {
    if (showExitConfirm) return;
    if (sessionInProgress) { setShowExitConfirm(true); return; }
    hardReturnHome();
  }

  /* Deterministic return to a clean encounter state.
     Never calls saveEntry — an abandoned attempt must not become an archive record. */
  function hardReturnHome() {
    clearInterval(timerRef.current);
    clearInterval(tickRef.current);
    drawSeqRef.current += 1;        // any pending landing is now void
    spinningRef.current = false;
    setLockedSlotH(null);
    stopRollAudio();
    recorder.abort();

    resetSession();   // releases session object URLs
    setTopic(null);
    setPrevTopicId(null);
    setSpinning(false);
    setReelItems([]);
    setReelAnim(false);
    setReelY(0);
    setAttemptNumber(1);
    setShowExitConfirm(false);
    setShowArchive(false);
    setPhase("idle");
  }

  /* ---------- ARCHIVE DELETION ---------- */

  async function removeEntry(id) {
    await deleteEntry(id);        // removes the IndexedDB record, blobs included
    setConfirmDeleteId(null);
    await refreshArchive();       // list + dueReturns both derive from entries
  }

  async function doExport() {
    const { manifest, audio } = await exportArchive();
    downloadBlob(manifest, "curio-archive.json");
    audio.forEach((f, i) => setTimeout(() => downloadBlob(f.blob, f.name), i * 250));
  }

  /* ---------- styles ---------- */

  const base = {
    fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
    cursor: "pointer", minHeight: 48,
    transition: "opacity .18s, transform .12s, background .2s, border-color .2s",
  };
  const primary = { ...base, background: t.accent, color: t.onAccent, border: "none", borderRadius: 14, fontWeight: 700 };
  const ghost = { ...base, background: "transparent", color: t.text, border: `1px solid ${t.line}`, borderRadius: 14 };
  const eyebrow = { fontSize: 11.5, letterSpacing: ".2em", color: t.muted, fontWeight: 700 };

  const rm = topic?.reference_material;

  /* Thinking stages are deliberately quiet — no artwork behind the work. */
  const QUIET_PHASES = ["commit", "research", "ready", "speak", "reveal"];
  const quietStage = Boolean(topic) && QUIET_PHASES.includes(phase);
  const stageArt = spinning
    ? CURIO_ASSETS.rolling
    : entries.length > 0
      ? CURIO_ASSETS.knowledgeBook   // knowledge uncovered and preserved
      : CURIO_ASSETS.home;           // knowledge still hidden

  return (
    <div
      className="curio-root"
      style={{
        "--c-bg": t.bg,
        "--c-flat": t.flat,
        "--c-surface": t.surface,
        "--c-surface-alt": t.surfaceAlt,
        "--c-text": t.text,
        "--c-muted": t.muted,
        "--c-line": t.line,
        "--c-accent": t.accent,
        "--c-amber": t.amber,
        "--c-focal": t.focal,
        "--c-vignette": t.vignette,
        "--c-glint": t.glint,
        "--c-scrim-top": t.scrimTop,
        "--c-scrim-bottom": t.scrimBottom,
        "--c-scrim-stop": isMobile ? "48%" : "62%",
        "--c-art-opacity": isMobile ? 0.62 : 0.80,
        "--c-art-position": isMobile ? "50% 72%" : "50% 50%",
        "--c-slot": `${activeSlotH}px`,
      }}
    >
      <BackgroundStage art={stageArt} isMobile={isMobile} quiet={quietStage} />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400&family=Atkinson+Hyperlegible:wght@400;700&display=swap');
      `}</style>

      <div className="curio-shell">

        {/* masthead */}
        <header className="curio-masthead">
          <button className="tap disp curio-wordmark" onClick={goHome}
            aria-label={sessionInProgress ? "Leave this session and return home" : "Curio home"}
            style={{ ...base, minHeight: 40, border: "none", padding: 0,
              fontWeight: 600, letterSpacing: "-.015em",
              fontFamily: "'Fraunces', Georgia, serif" }}>
            Curio
          </button>
          <div className="curio-navgroup">
            <button className="tap curio-iconbtn" aria-label="Switch theme"
              onClick={() => setThemeName(themeName === "dark" ? "light" : "dark")}
              style={ghost}>
              {themeName === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button className="tap curio-navbtn" aria-label="Your archive" onClick={() => setShowArchive(true)}
              style={ghost}>
              <Archive size={15} /> {entries.length}
            </button>
          </div>
        </header>

        <main className="curio-canvas">

        {/* ---------- IDLE / ENCOUNTER ---------- */}
        {!topic && !spinning && (
          <div className="r1">
            <div className="curio-modes">
              {Object.entries(MODES).map(([k, m]) => (
                <button key={k} className="tap" onClick={() => setMode(k)}
                  style={{ ...base, flex: 1, minHeight: 44, borderRadius: 999, border: "none",
                    background: mode === k ? t.accent : "transparent",
                    color: mode === k ? t.onAccent : t.muted, fontSize: 14.5, fontWeight: 700 }}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="curio-invitation">{MODES[mode].sub}</p>

            {phase === "saved" && (
              <p className="curio-saved-note" style={{ color: t.accent }}>Saved to your archive.</p>
            )}

            <button className="tap curio-cta" onClick={() => draw()} style={primary}>
              Draw today&apos;s discovery
            </button>

            {dueReturns.length > 0 && (
              <button className="tap curio-revisit" onClick={() => draw(dueReturns[0].topic_id)}
                style={ghost}>
                <RotateCcw size={15} /> Revisit {dueReturns[0].title}
              </button>
            )}
          </div>
        )}

        {/* ---------- REEL ---------- */}
        {spinning && (
          <div>
            <div className="curio-eyebrow" style={{ color: t.amber }}>DRAWING</div>
            <div className="curio-reel">
              <div className="curio-reel__window" />
              <div className="curio-reel__fade" />
              <div onTransitionEnd={onReelEnd}
                style={{ transform: `translateY(${reelY}px)`, transition: reelAnim ? "transform 3.1s cubic-bezier(.06,.7,.14,1)" : "none" }}>
                {reelItems.map((x, i) => (
                  <div key={`${x.id}-${i}`} className="curio-reel__slot">
                    <span className="disp curio-reel__title">{x.title}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------- TOPIC ---------- */}
        {topic && !spinning && (
          <div>
            <div className="r1 curio-eyebrow" style={{ color: t.amber }}>
              {attemptNumber > 1 ? `RETURN · ATTEMPT ${attemptNumber}` : "TODAY'S DISCOVERY"}
            </div>

            <h1 className={`disp curio-title ${landed ? "settle" : ""}`}
              style={{ textAlign: "center", margin: "0 0 18px" }}>
              {topic.title}
            </h1>

            <p className="r2 curio-hook">
              {topic.hook}
            </p>

            {/* ENCOUNTER actions */}
            {phase === "idle" && (
              <div className="r3">
                <button className="tap" onClick={beginCommit}
                  style={{ ...primary, width: "100%", padding: 17, fontSize: 16, marginBottom: 10 }}>
                  Make your guess
                </button>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={() => draw()}
                    style={{ ...ghost, flex: 1, padding: 14, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Draw another
                  </button>
                  {prevTopicId && (
                    <button className="tap" onClick={goBack}
                      style={{ ...ghost, padding: "14px 18px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <ChevronLeft size={15} /> Back
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* COMMIT */}
            {phase === "commit" && (
              <div className="r1">
                <div style={{ ...eyebrow, marginBottom: 10 }}>BEFORE YOU LOOK ANYTHING UP</div>
                <p className="disp" style={{ fontSize: 20, lineHeight: 1.45, margin: "0 0 24px" }}>
                  {topic.prediction_prompt}
                </p>

                {recorder.error && (
                  <div style={{ fontSize: 14.5, color: t.amber, lineHeight: 1.5, border: `1px solid ${t.line}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                    Recording needs microphone access. Allow it, or skip the guess.
                  </div>
                )}

                {activeRecording === "prediction" ? (
                  <div style={{ textAlign: "center" }}>
                    <div className="breathe" style={{ ...eyebrow, color: t.amber, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.amber }} /> RECORDING YOUR GUESS
                    </div>
                    {recorder.transcript && (
                      <div style={{ fontSize: 14.5, color: t.muted, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 14, marginBottom: 16, textAlign: "left", maxHeight: 110, overflowY: "auto", lineHeight: 1.6 }}>
                        {recorder.transcript}
                      </div>
                    )}
                    <button className="tap" onClick={stopPrediction} aria-label="Stop"
                      style={{ ...base, background: t.text, color: t.flat, border: "none", borderRadius: "50%", width: 70, height: 70, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <Square size={21} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button className="tap" onClick={startPrediction}
                      style={{ ...primary, width: "100%", padding: 18, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
                      <Mic size={17} /> Record my guess
                    </button>
                    <button className="tap" onClick={skipPrediction}
                      style={{ ...ghost, width: "100%", padding: 13, fontSize: 14 }}>
                      Skip the guess
                    </button>
                  </>
                )}
              </div>
            )}

            {/* RESEARCH — reference_material only. Never the briefing. */}
            {phase === "research" && (
              <div className="r1">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
                  <span style={eyebrow}>RESEARCH IT YOURSELF</span>
                  <span className="disp" style={{ fontSize: 26, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmt(timeLeft)}</span>
                </div>

                {rm?.names?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>NAMES</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {rm.names.map((x) => (
                        <span key={x} style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 999, padding: "7px 13px", fontSize: 14 }}>{x}</span>
                      ))}
                    </div>
                  </div>
                )}

                {rm?.timeline?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>WHEN</div>
                    {rm.timeline.map((x) => (
                      <div key={x} style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 5 }}>{x}</div>
                    ))}
                  </div>
                )}

                {rm?.terms?.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>LOOK THESE UP</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {rm.terms.map((x) => (
                        <span key={x} className="disp" style={{ color: t.accent, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 10, padding: "8px 13px", fontSize: 15.5, fontWeight: 600 }}>{x}</span>
                      ))}
                    </div>
                  </div>
                )}

                {rm?.research_threads?.length > 0 && (
                  <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16, marginBottom: 26 }}>
                    <div style={{ ...eyebrow, marginBottom: 10 }}>QUESTIONS TO CHASE</div>
                    {rm.research_threads.map((x) => (
                      <p key={x} className="disp" style={{ fontSize: 17, lineHeight: 1.45, margin: "0 0 10px", fontStyle: "italic" }}>{x}</p>
                    ))}
                  </div>
                )}

                {revealedEarly && (
                  <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>THE BRIEFING</div>
                    <p style={{ fontSize: 15.5, lineHeight: 1.65, margin: 0 }}>{topic.briefing}</p>
                  </div>
                )}

                <button className="tap" onClick={() => { clearInterval(timerRef.current); setPhase("ready"); }}
                  style={{ ...primary, width: "100%", padding: 17, fontSize: 16, marginBottom: 10 }}>
                  I&apos;m ready to explain
                </button>

                {!revealedEarly && (
                  <button className="tap" onClick={() => setRevealedEarly(true)}
                    style={{ ...ghost, width: "100%", padding: 13, fontSize: 13.5, color: t.muted }}>
                    I&apos;m stuck — show me the briefing
                  </button>
                )}
              </div>
            )}

            {/* READY */}
            {phase === "ready" && (
              <div className="r1">
                <button className="tap" onClick={startExplanation}
                  style={{ ...primary, width: "100%", padding: 18, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
                  <Mic size={17} /> Explain it in your own words
                </button>
                {mode === "deep" && (
                  <button className="tap" onClick={() => setPhase("research")}
                    style={{ ...ghost, width: "100%", padding: 13, fontSize: 14 }}>
                    Back to research
                  </button>
                )}
                {recorder.error && (
                  <div style={{ fontSize: 14.5, color: t.amber, textAlign: "center", lineHeight: 1.5, marginTop: 12 }}>
                    Recording needs microphone access. Allow it in your browser settings.
                  </div>
                )}
              </div>
            )}

            {/* EXPLAIN */}
            {phase === "speak" && (
              <div style={{ textAlign: "center" }}>
                <div className="breathe" style={{ ...eyebrow, color: t.amber, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.amber }} /> RECORDING
                </div>
                {recorder.transcript && (
                  <div style={{ fontSize: 15, color: t.muted, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 15, marginBottom: 18, textAlign: "left", maxHeight: 120, overflowY: "auto", lineHeight: 1.6 }}>
                    {recorder.transcript}
                  </div>
                )}
                <button className="tap" onClick={stopExplanation} aria-label="Stop recording"
                  style={{ ...base, background: t.text, color: t.flat, border: "none", borderRadius: "50%", width: 70, height: 70, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <Square size={21} />
                </button>
              </div>
            )}

            {/* REVEAL — the only place briefing and misconception appear */}
            {phase === "reveal" && (
              <div className="r1">
                <div style={{ textAlign: "center", marginBottom: 22 }}>
                  <p className="disp" style={{ fontSize: 20, lineHeight: 1.45, margin: 0, fontWeight: 500 }}>
                    You spoke for {elapsed < 1 ? `${Math.round(elapsed * 60)} seconds` : `${elapsed.toFixed(1)} minutes`}.
                  </p>
                </div>

                <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.amber}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
                  <div style={{ ...eyebrow, marginBottom: 8 }}>MOST PEOPLE THINK</div>
                  <p style={{ fontSize: 15.5, lineHeight: 1.6, margin: 0 }}>{topic.misconception}</p>
                </div>

                <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.accent}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                  <div style={{ ...eyebrow, marginBottom: 8 }}>WHAT IS ACTUALLY KNOWN</div>
                  <p style={{ fontSize: 15.5, lineHeight: 1.65, margin: 0 }}>{topic.briefing}</p>
                </div>

                {prediction.url && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>YOUR GUESS</div>
                    <audio controls src={prediction.url} style={{ width: "100%", height: 40 }} />
                  </div>
                )}
                {explanation.url && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>YOUR EXPLANATION</div>
                    <audio controls src={explanation.url} style={{ width: "100%", height: 40 }} />
                  </div>
                )}

                {priorEntry && (
                  <div style={{ background: t.surfaceAlt, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>
                      YOU EXPLAINED THIS ON {new Date(priorEntry.created_at).toLocaleDateString()}
                    </div>
                    {priorEntry.explanation?.blob && (
                      <audio controls src={entryUrls[priorEntry.id]} style={{ width: "100%", height: 40 }} />
                    )}
                    {priorEntry.explanation?.transcript && (
                      <p style={{ fontSize: 14, color: t.muted, lineHeight: 1.6, marginTop: 10, marginBottom: 0 }}>
                        {priorEntry.explanation.transcript}
                      </p>
                    )}
                  </div>
                )}

                {aiAvailable() && !feedback && !fbLoading && explanation.transcript && (
                  <button className="tap" onClick={loadFeedback}
                    style={{ ...base, width: "100%", background: "transparent", border: `1px dashed ${t.amber}55`, color: t.amber, borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <Sparkles size={15} /> How did I do?
                  </button>
                )}
                {fbLoading && <div className="breathe" style={{ textAlign: "center", fontSize: 15, color: t.amber, fontWeight: 700, marginBottom: 16 }}>Listening closely…</div>}
                {fbError && <div style={{ fontSize: 14.5, color: t.amber, textAlign: "center", marginBottom: 16 }}>Feedback did not load.</div>}

                {feedback && (
                  <div style={{ marginBottom: 16 }}>
                    {feedback.encouragement && (
                      <p className="disp" style={{ fontSize: 18, lineHeight: 1.55, margin: "0 0 16px", textAlign: "center" }}>{feedback.encouragement}</p>
                    )}
                    {feedback.understanding && (
                      <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
                        <div style={{ ...eyebrow, marginBottom: 8 }}>DID YOU EXPLAIN IT?</div>
                        <div className="disp" style={{ fontSize: 17, fontWeight: 600, color: t.accent, marginBottom: 8 }}>{feedback.understanding.verdict}</div>
                        <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>{feedback.understanding.detail}</p>
                      </div>
                    )}
                    {feedback.next_time && (
                      <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16 }}>
                        <div style={{ ...eyebrow, marginBottom: 6 }}>NEXT TIME</div>
                        <p style={{ fontSize: 15.5, lineHeight: 1.6, margin: 0 }}>{feedback.next_time}</p>
                      </div>
                    )}
                  </div>
                )}

                {topic.discussion_prompt && (
                  <div style={{ borderLeft: `2px solid ${t.muted}`, paddingLeft: 16, marginBottom: 20 }}>
                    <div style={{ ...eyebrow, marginBottom: 6 }}>THINK ABOUT</div>
                    <p className="disp" style={{ fontSize: 17.5, lineHeight: 1.45, margin: 0, fontStyle: "italic" }}>{topic.discussion_prompt}</p>
                  </div>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={preserve}
                    style={{ ...primary, flex: 1, padding: 15, fontSize: 15.5 }}>
                    Save entry
                  </button>
                  <button className="tap" onClick={() => draw()}
                    style={{ ...ghost, padding: "15px 20px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Another
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        </main>
      </div>

      {/* ---------- LEAVE SESSION CONFIRMATION ---------- */}
      {showExitConfirm && (
        <div role="dialog" aria-modal="true" aria-labelledby="exit-title"
          className="curio-modal"
          onClick={() => setShowExitConfirm(false)}>
          <div onClick={(e) => e.stopPropagation()}
            className="curio-modal__panel">
            <h2 id="exit-title" className="disp"
              style={{ fontSize: 21, fontWeight: 600, margin: "0 0 10px" }}>
              Leave this session?
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: t.muted, margin: "0 0 22px" }}>
              You are part-way through {topic ? topic.title : "a discovery"}. Nothing from this
              attempt will be saved to your archive.
            </p>
            <div className="curio-modal__actions">
              <button className="tap" onClick={hardReturnHome}
                style={{ ...primary, flex: 1, padding: 14, fontSize: 15 }}>
                Yes, leave
              </button>
              <button className="tap" onClick={() => setShowExitConfirm(false)}
                style={{ ...ghost, flex: 1, padding: 14, fontSize: 15 }}>
                No, keep going
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ARCHIVE ---------- */}
      {showArchive && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(8,12,16,.6)", display: "flex", justifyContent: "flex-end", zIndex: 60 }}
          onClick={() => { setShowArchive(false); setConfirmDeleteId(null); }}>
          <div onClick={(e) => e.stopPropagation()}
            className="curio-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div className="disp curio-drawer__title">Your archive</div>
              <button className="tap" onClick={() => { setShowArchive(false); setConfirmDeleteId(null); }} aria-label="Close"
                style={{ ...ghost, minHeight: 40, borderRadius: 999, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <X size={16} />
              </button>
            </div>

            {entries.length > 0 && (
              <button className="tap" onClick={doExport}
                style={{ ...ghost, width: "100%", padding: 12, fontSize: 14, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Download size={15} /> Export everything
              </button>
            )}

            {entries.length === 0 && (
              <p style={{ fontSize: 15, color: t.muted, lineHeight: 1.6 }}>
                Nothing saved yet. Draw a discovery and record your first entry.
              </p>
            )}

            {entries.map((e) => (
              <div key={e.id} className="curio-entry">
                <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>{e.topic_title}</div>
                <div style={{ fontSize: 12.5, color: t.muted, marginTop: 4 }}>
                  {new Date(e.created_at).toLocaleString()} · {MODES[e.mode]?.label ?? e.mode}
                  {e.attempt_number > 1 ? ` · attempt ${e.attempt_number}` : ""}
                </div>
                {entryUrls[e.id] && (
                  <audio controls src={entryUrls[e.id]} style={{ width: "100%", marginTop: 10, height: 36 }} />
                )}
                {e.revealed_early && (
                  <div style={{ fontSize: 12.5, color: t.muted, marginTop: 8 }}>Briefing revealed during research</div>
                )}

                {confirmDeleteId === e.id ? (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${t.line}`, paddingTop: 12 }}>
                    <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 10 }}>
                      Delete this entry permanently? The recording cannot be recovered.
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="tap" onClick={() => removeEntry(e.id)}
                        style={{ ...base, flex: 1, minHeight: 42, borderRadius: 10, border: "none",
                          background: t.amber, color: t.onAccent, fontSize: 14, fontWeight: 700 }}>
                        Delete
                      </button>
                      <button className="tap" onClick={() => setConfirmDeleteId(null)}
                        style={{ ...ghost, minHeight: 42, borderRadius: 10, padding: "0 16px", fontSize: 14 }}>
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="tap" onClick={() => setConfirmDeleteId(e.id)}
                    aria-label={`Delete entry: ${e.topic_title}`}
                    style={{ ...base, minHeight: 36, marginTop: 10, background: "none", border: "none",
                      padding: 0, color: t.muted, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
