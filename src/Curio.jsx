import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Mic, Square, Archive, X, Download, RotateCcw, ChevronLeft, Sparkles,
  Sun, Moon, Trash2,
} from "lucide-react";

import { getCatalogue, loadTopic, pickRandomId, reelTitles } from "./services/topicLoader";
import {
  saveEntry, listEntries, getDueReturns, previousAttempt, attemptCountFor,
  deleteEntry, exportArchive, downloadBlob,
} from "./services/archive";
import { requestFeedback, aiAvailable } from "./services/ai";

/* ============================================================================
   Curio

   Loop:  Encounter -> Commit -> Research -> Explain -> Reveal -> Preserve -> Return

   Product invariants enforced here:
     - `briefing` never reaches the screen before an explanation exists, unless
       the user explicitly asks; that request is recorded as revealed_early.
     - `reference_material` is the only material shown during research.
     - `misconception` and the full briefing belong to the reveal stage.
     - Categories are never user-facing. No scores, streaks, points or overdue
       language anywhere.
     - Abandoning a session never writes an archive entry.

   Presentation lives in index.css. The only value written into CSS from here
   is --c-slot, because the same number drives the reel's landing transform.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   Assets — the single place image and audio paths live. Every file is optional:
   a missing image leaves the gradient environment, a missing sound falls back
   to a synthesised tone.
   --------------------------------------------------------------------------- */
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

const MODES = {
  cuff: { label: "Off the cuff", seconds: 120, sub: "Guess, then explain. No research." },
  deep: { label: "Deep dive", seconds: 900, sub: "Guess, research it yourself, then explain." },
};

const MIC_MESSAGES = {
  denied: "Recording needs microphone access. Allow it in your browser settings, then try again.",
  missing: "No microphone was found. Connect one and try again.",
  busy: "Your microphone is in use by another application. Close it and try again.",
  unsupported: "This browser cannot record audio. You can still read and think through the topic.",
  unavailable: "The microphone could not be started. Please try again.",
};

const QUIET_PHASES = ["commit", "research", "ready", "speak", "reveal"];

const FILLERS = ["um", "uh", "like", "you know", "so yeah", "basically", "actually"];

/* ---------------------------------------------------------------------------
   Reel geometry

   One number governs everything: slotH.
     --c-slot -> .curio-reel (3 slots), .curio-reel__window, .curio-reel__slot
     LAND_Y   -> (FINAL_IDX - 1) * slotH, the animation target
   so item FINAL_IDX always lands at offset exactly slotH: the centre slot.

   Width sets the intended scale; the height actually available on the drawing
   screen caps it. The cap is derived from the vertical values in index.css.
   --------------------------------------------------------------------------- */

const REEL_LEN = 30;
const FINAL_IDX = 28;
const REEL_SPIN_MS = 3100;         // must match .curio-reel__strip transition below
const REEL_SETTLE_GRACE_MS = 260;  // fallback margin if transitionend never fires

/* Anchors mirror the desktop breakpoints in index.css. Values between anchors
   are interpolated, so there is no discontinuity at any width. */
const SLOT_ANCHORS = [
  [768, 92],
  [1024, 150],
  [1280, 180],
  [1440, 210],
  [1920, 235],
  [2560, 250],
];

/* Floor of last resort. The height cap may go below the tablet anchor on very
   short screens: claiming a larger slot "fits" when it does not is worse. */
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

/* Everything on the drawing screen except the reel. Each term mirrors a real
   declaration in index.css, so the model tracks the stylesheet:
     .curio-shell    padding-top (per breakpoint) + padding-bottom
     .curio-masthead control row height + margin-bottom
     .curio-eyebrow  11.5px x line-height 1.6, plus margin-bottom
     .curio-canvas   padding-bottom 5vh
   The @media (max-height: 620px) overrides are reproduced too. */
function desktopChrome(width, height) {
  const vh = height / 100;
  const short = height <= SHORT_VIEWPORT_H;

  let shellPadTop;
  let controlRow;
  if (width >= 1920) { shellPadTop = cssClamp(36, 3.8 * vh, 60); controlRow = 48; }
  else if (width >= 1440) { shellPadTop = cssClamp(32, 3.5 * vh, 52); controlRow = 48; }
  else if (width >= 1280) { shellPadTop = cssClamp(28, 3.2 * vh, 46); controlRow = 46; }
  else { shellPadTop = cssClamp(24, 3.0 * vh, 40); controlRow = 44; }

  const mastheadGap = short ? 18 : cssClamp(40, 6 * vh, 72);
  const eyebrowBlock = 11.5 * 1.6 + cssClamp(14, 3 * vh, 20);
  const shellPadBot = short ? 40 : 56;
  const canvasPadBot = short ? 0 : 5 * vh;

  return shellPadTop + controlRow + mastheadGap + eyebrowBlock + shellPadBot + canvasPadBot;
}

function slotHeightFor(width, height) {
  // Mobile is deliberately fixed and independent of viewport height.
  if (width < 360) return 64;
  if (width < BREAKPOINT_MOBILE) return 72;

  const byWidth = slotByWidth(width);
  const byHeight = (height - desktopChrome(width, height)) / 3;

  // floor, not round: guarantees 3 * slotH <= available reel space
  return Math.max(ABSOLUTE_MIN_SLOT, Math.floor(Math.min(byWidth, byHeight)));
}

function readViewport() {
  if (typeof window === "undefined") return { w: 1280, h: 900 };
  return { w: window.innerWidth, h: window.innerHeight };
}

function useViewport(frozen) {
  const [vp, setVp] = useState(readViewport);

  useEffect(() => {
    if (frozen) return undefined; // geometry must not move mid-spin
    const onResize = () => setVp(readViewport());
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [frozen]);

  return slotHeightFor(vp.w, vp.h);
}

function prefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function initialTheme() {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  // System preference is a starting default only; the toggle is authoritative.
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const fmt = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/* ---------------------------------------------------------------------------
   Audio — decorative only. One shared AudioContext; a clip is reported as
   playing only after play() actually resolves, so callers never believe an
   asset exists when playback was blocked or the file is missing.
   --------------------------------------------------------------------------- */

let sharedCtx = null;

function audioContext() {
  const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return null;
  try {
    if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new Ctx();
    if (sharedCtx.state === "suspended") sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch {
    return null;
  }
}

function tone(freqs, vol = 0.06, dur = 0.09) {
  const ctx = audioContext();
  if (!ctx) return;
  try {
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
  } catch {
    /* decorative */
  }
}

/** Resolves with the element only if playback genuinely started. */
async function playClip(src, { loop = false } = {}) {
  if (typeof Audio === "undefined") return null;
  try {
    const el = new Audio(src);
    el.loop = loop;
    el.volume = 0.35;
    el.preload = "auto";
    const started = el.play();
    if (started && typeof started.then === "function") await started;
    return el;
  } catch {
    return null; // missing file, decode failure, or autoplay refusal
  }
}

function stopClip(el) {
  if (!el) return;
  try {
    el.pause();
    el.currentTime = 0;
    el.src = "";
  } catch {
    /* already released */
  }
}

/* ---------------------------------------------------------------------------
   BackgroundStage

   <picture> performs art direction; onError removes the image layer entirely,
   so a missing asset is invisible rather than a broken image. Quiet stages
   render no artwork: the user has stepped away from the environment to think.
   --------------------------------------------------------------------------- */

function BackgroundStage({ art, quiet }) {
  const [failed, setFailed] = useState(false);
  const key = art?.desktop ?? "";

  useEffect(() => {
    setFailed(false);
  }, [key]);

  const showArt = Boolean(art) && !quiet && !failed;

  return (
    <div className="curio-stage" aria-hidden="true">
      <div className="curio-stage__base" />
      {showArt && (
        <picture>
          <source media={`(max-width: ${BREAKPOINT_MOBILE - 1}px)`} srcSet={art.mobile} />
          <img
            className="curio-stage__art"
            src={art.desktop}
            alt=""
            decoding="async"
            onError={() => setFailed(true)}
          />
        </picture>
      )}
      {showArt && <div className="curio-stage__scrim" />}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   useRecorder — one implementation, used for both the prediction and the
   explanation.

   Speech recognition is an enhancement: when it is unavailable or fails, audio
   recording still works and the session can still be saved. A generation token
   makes callbacks from an abandoned take unable to affect a newer one, and the
   media stream is released on every exit path.
   --------------------------------------------------------------------------- */

function mapMicError(err) {
  // Distinguish the failures the user can actually act on.
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "unavailable";
  }
}

/* Milliseconds to let SpeechRecognition deliver its last final result after the
   recorder has stopped. Short enough not to be felt, long enough that a word
   spoken at the very end usually lands in the finalized transcript. */
const SPEECH_SETTLE_MS = 350;

/**
 * useRecorder — one implementation, used for both the prediction and the
 * explanation.
 *
 * Lifecycle: idle -> starting -> recording -> stopping -> idle, tracked in a
 * ref because every transition must be observable synchronously by the next
 * caller, before React has re-rendered.
 *
 * Two properties matter most in production:
 *
 *  - stop() is idempotent. A stop operation can outlive the click that started
 *    it, so one shared promise is kept and every caller awaiting the same stop
 *    observes the same finalized take. Nothing is resolved twice and nothing is
 *    left hanging.
 *
 *  - Every asynchronous path is generation-checked. Permission prompts, media
 *    callbacks and speech results can all arrive after the take they belong to
 *    was abandoned, and none of them may touch a newer take.
 *
 * SpeechRecognition is an enhancement throughout: when it is missing or fails,
 * audio recording and saving still work and the transcript is simply empty.
 */
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState(null);

  const genRef = useRef(0);
  const stateRef = useRef("idle"); // idle | starting | recording | stopping
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const srRef = useRef(null);
  const srEndRef = useRef(null);
  const chunksRef = useRef([]);
  const transcriptRef = useRef("");
  const startPromiseRef = useRef(null);
  const stopPromiseRef = useRef(null);
  const settleRef = useRef(null);

  const releaseStream = useCallback(() => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* tracks already ended */
    }
    streamRef.current = null;
  }, []);

  const teardownMedia = useCallback(() => {
    try { srRef.current?.stop(); } catch { /* already inactive */ }
    srRef.current = null;
    srEndRef.current = null;
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {
      /* already inactive */
    }
    recRef.current = null;
    releaseStream();
  }, [releaseStream]);

  /* Resolves the shared stop promise exactly once. A take from a superseded
     generation resolves empty so it can never be committed by its caller. */
  const finalize = useCallback(
    (gen, blob) => {
      const settle = settleRef.current;
      settleRef.current = null;
      stopPromiseRef.current = null;
      recRef.current = null;
      chunksRef.current = [];
      stateRef.current = "idle";
      releaseStream();

      const current = gen === genRef.current;
      setRecording(false);
      settle?.(
        current
          ? { blob: blob ?? null, transcript: transcriptRef.current.trim() }
          : { blob: null, transcript: "" }
      );
    },
    [releaseStream]
  );

  /* SpeechRecognition emits its last final result while stopping. Give it a
     bounded window so the finalized transcript is as complete as it can be,
     without ever making the stop depend on it. */
  const waitForSpeech = useCallback(() => {
    const sr = srRef.current;
    srRef.current = null;
    if (!sr) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        srEndRef.current = null;
        resolve();
      };
      srEndRef.current = finish;
      try { sr.stop(); } catch { finish(); }
      setTimeout(finish, SPEECH_SETTLE_MS);
    });
  }, []);

  const beginRecording = useCallback(
    async (gen) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia
        || typeof MediaRecorder === "undefined") {
        if (gen === genRef.current) {
          stateRef.current = "idle";
          setError("unsupported");
        }
        return false;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        // A denial belonging to an abandoned attempt must not surface later.
        if (gen === genRef.current) {
          stateRef.current = "idle";
          setError(mapMicError(err));
        }
        return false;
      }

      // Abandoned while the permission prompt was open.
      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      streamRef.current = stream;
      chunksRef.current = [];
      transcriptRef.current = "";

      let rec;
      try {
        rec = new MediaRecorder(stream);
      } catch {
        releaseStream();
        stateRef.current = "idle";
        setError("unsupported");
        return false;
      }

      rec.ondataavailable = (e) => {
        if (gen === genRef.current && e.data?.size) chunksRef.current.push(e.data);
      };

      rec.onstop = () => {
        const parts = chunksRef.current;
        const blob = parts.length
          ? new Blob(parts, { type: rec.mimeType || "audio/webm" })
          : null;
        waitForSpeech().then(() => finalize(gen, blob));
      };

      try {
        rec.start();
      } catch {
        releaseStream();
        stateRef.current = "idle";
        setError("unsupported");
        return false;
      }

      recRef.current = rec;

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        try {
          const r = new SR();
          r.continuous = true;
          r.interimResults = true;
          r.lang = "en-US";
          let settled = "";
          r.onresult = (e) => {
            if (gen !== genRef.current) return;
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i += 1) {
              if (e.results[i].isFinal) settled += `${e.results[i][0].transcript} `;
              else interim += e.results[i][0].transcript;
            }
            transcriptRef.current = settled + interim;
            setTranscript(transcriptRef.current);
          };
          r.onerror = () => {
            // Enhancement only: the take proceeds with whatever text exists.
            srEndRef.current?.();
          };
          r.onend = () => { srEndRef.current?.(); };
          r.start();
          srRef.current = r;
        } catch {
          srRef.current = null;
        }
      }

      stateRef.current = "recording";
      setError(null);
      setTranscript("");
      setRecording(true);
      return true;
    },
    [finalize, releaseStream, waitForSpeech]
  );

  /* Only one start may become authoritative. Repeat calls observe the pending
     attempt rather than acquiring a second microphone stream. */
  const start = useCallback(() => {
    if (stateRef.current === "starting" && startPromiseRef.current) {
      return startPromiseRef.current;
    }
    if (stateRef.current === "recording") return Promise.resolve(true);
    if (stateRef.current === "stopping") return Promise.resolve(false);

    stateRef.current = "starting";
    const gen = ++genRef.current;
    const p = beginRecording(gen).finally(() => {
      if (startPromiseRef.current === p) startPromiseRef.current = null;
    });
    startPromiseRef.current = p;
    return p;
  }, [beginRecording]);

  /**
   * Stops and resolves with { blob, transcript } for this take.
   * Safe to call repeatedly: every caller receives the same finalized result.
   */
  const stop = useCallback(() => {
    if (stopPromiseRef.current) return stopPromiseRef.current;

    if (stateRef.current === "starting") {
      // No take exists yet. Invalidate the pending acquisition and resolve
      // deterministically rather than waiting on a recording that never began.
      genRef.current += 1;
      stateRef.current = "idle";
      startPromiseRef.current = null;
      teardownMedia();
      setRecording(false);
      return Promise.resolve({ blob: null, transcript: "" });
    }

    if (stateRef.current !== "recording") {
      return Promise.resolve({ blob: null, transcript: transcriptRef.current.trim() });
    }

    const gen = genRef.current;
    stateRef.current = "stopping";
    setRecording(false);

    const p = new Promise((resolve) => { settleRef.current = resolve; });
    stopPromiseRef.current = p;

    try {
      recRef.current.stop(); // onstop drives finalize()
    } catch {
      finalize(gen, null);
    }
    return p;
  }, [finalize, teardownMedia]);

  /* Discards the take and releases the microphone. The generation is bumped
     first so callbacks still in flight cannot touch anything afterwards, and
     any caller awaiting a stop is resolved rather than left hanging. */
  const abort = useCallback(() => {
    genRef.current += 1;
    const settle = settleRef.current;
    settleRef.current = null;
    stopPromiseRef.current = null;
    startPromiseRef.current = null;
    srEndRef.current = null;

    teardownMedia();
    chunksRef.current = [];
    transcriptRef.current = "";
    stateRef.current = "idle";

    setRecording(false);
    setTranscript("");
    setError(null);
    settle?.({ blob: null, transcript: "" });
  }, [teardownMedia]);

  const reset = useCallback(() => {
    transcriptRef.current = "";
    setTranscript("");
    setError(null);
  }, []);

  useEffect(
    () => () => {
      genRef.current += 1;
      settleRef.current?.({ blob: null, transcript: "" });
      settleRef.current = null;
      teardownMedia();
    },
    [teardownMedia]
  );

  return { recording, transcript, error, start, stop, abort, reset };
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])", "audio[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Real focus containment for a modal surface.
 *
 * aria-modal="true" is a promise to assistive technology, not an implementation:
 * it does not stop Tab from walking into the application behind the dialog. This
 * moves focus in, cycles it within the dialog, handles Escape, and returns focus
 * to whatever opened it when the surface closes.
 */
function useFocusTrap(active, containerRef, onClose) {
  useEffect(() => {
    if (!active) return undefined;
    const node = containerRef.current;
    if (!node) return undefined;

    const opener = document.activeElement;
    node.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;

      if (e.shiftKey) {
        if (current === first || current === node || !node.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !node.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [active, containerRef, onClose]);
}

/* ========================================================================== */

export default function Curio() {
  const [theme, setTheme] = useState(initialTheme);

  // --- session ---
  const [phase, setPhase] = useState("idle"); // idle|commit|research|ready|speak|reveal|saved
  const [mode, setMode] = useState("deep");
  const [topic, setTopic] = useState(null);
  const [topicLoading, setTopicLoading] = useState(false);
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [seenIds, setSeenIds] = useState([]);
  const [topicError, setTopicError] = useState(false);

  // --- draw ---
  const [spinning, setSpinning] = useState(false);
  const [reelItems, setReelItems] = useState([]);
  const [reelY, setReelY] = useState(0);
  const [reelAnim, setReelAnim] = useState(false);
  const [landed, setLanded] = useState(false);

  // --- recordings ---
  const [prediction, setPrediction] = useState({ blob: null, url: null, transcript: "" });
  const [explanation, setExplanation] = useState({ blob: null, url: null, transcript: "" });
  const [activeTake, setActiveTake] = useState(null); // "prediction" | "explanation" | null
  const recorder = useRecorder();

  // --- research ---
  const [timeLeft, setTimeLeft] = useState(MODES.deep.seconds);
  const [revealedEarly, setRevealedEarly] = useState(false);

  // --- reveal ---
  const [elapsed, setElapsed] = useState(0);
  const [priorEntry, setPriorEntry] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [fbState, setFbState] = useState("idle"); // idle|loading|error
  const [saveState, setSaveState] = useState("idle"); // idle|saving|error

  // --- archive ---
  const [entries, setEntries] = useState([]);
  const [entryUrls, setEntryUrls] = useState({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [dueReturns, setDueReturns] = useState([]);

  // --- navigation ---
  const [exitOpen, setExitOpen] = useState(false);

  // A spin locks the geometry it began with, so --c-slot and LAND_Y can never
  // originate from different snapshots.
  const liveSlotH = useViewport(spinning);
  const [lockedSlotH, setLockedSlotH] = useState(null);
  const slotH = lockedSlotH ?? liveSlotH;

  const timerRef = useRef(null);
  const tickRef = useRef(null);
  const settleRef = useRef(null);
  const rollAudioRef = useRef(null);
  const speakStartRef = useRef(null);
  const urlsRef = useRef([]);
  const spinningRef = useRef(false);
  const topicLoadingRef = useRef(false); // synchronous mirror of topicLoading
  const drawSeqRef = useRef(0);
  const archiveSeqRef = useRef(0);
  const fbSeqRef = useRef(0);
  const pendingSeqRef = useRef(0);
  const pendingTopicIdRef = useRef(null);
  const modalRef = useRef(null);
  const drawerRef = useRef(null);

  const catalogue = useMemo(() => getCatalogue(), []);

  /* ---------- archive loading ---------- */

  /* Refreshes can overlap. Only the newest may write, so a slow earlier request
     cannot overwrite newer entries or resurrect an error the newer one cleared. */
  const refreshArchive = useCallback(async () => {
    const seq = ++archiveSeqRef.current;
    try {
      const [list, due] = await Promise.all([listEntries(), getDueReturns()]);
      if (seq !== archiveSeqRef.current) return;
      setEntries(list);
      setDueReturns(due);
      setArchiveError(null);
    } catch {
      if (seq !== archiveSeqRef.current) return;
      setArchiveError("Your archive could not be loaded. Saved entries are safe on this device.");
    }
  }, []);

  useEffect(() => { refreshArchive(); }, [refreshArchive]);

  /* One object URL per saved entry, rebuilt only when the list changes.
     Creating these during render would leak a URL on every re-render. */
  useEffect(() => {
    const map = {};
    for (const e of entries) {
      if (e.explanation?.blob) map[e.id] = URL.createObjectURL(e.explanation.blob);
    }
    setEntryUrls(map);
    return () => Object.values(map).forEach((u) => URL.revokeObjectURL(u));
  }, [entries]);

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
      clearInterval(timerRef.current);
      clearInterval(tickRef.current);
      clearTimeout(settleRef.current);
      stopClip(rollAudioRef.current);
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
    },
    []
  );

  /* ---------- temporary session object URLs ----------
     These belong to the in-progress take only. Archive entry URLs are managed
     separately, above, and are never revoked because a session changed. */

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

  /* ---------- reel audio ---------- */

  function startTickFallback() {
    clearInterval(tickRef.current);
    let n = 0;
    tickRef.current = setInterval(() => {
      tone([600], 0.03, 0.045);
      n += 1;
      if (n > 22) clearInterval(tickRef.current);
    }, 100);
  }

  function startRollAudio(seq) {
    clearInterval(tickRef.current);
    stopClip(rollAudioRef.current);
    rollAudioRef.current = null;

    playClip(CURIO_ASSETS.sounds.topicRoll, { loop: true }).then((el) => {
      // The spin may already have ended or been abandoned while play() settled.
      if (!el) {
        if (spinningRef.current && drawSeqRef.current === seq) startTickFallback();
        return;
      }
      if (!spinningRef.current || drawSeqRef.current !== seq) {
        stopClip(el);
        return;
      }
      rollAudioRef.current = el;
    });
  }

  function stopRollAudio() {
    clearInterval(tickRef.current);
    stopClip(rollAudioRef.current);
    rollAudioRef.current = null;
  }

  async function playLandAudio() {
    const el = await playClip(CURIO_ASSETS.sounds.topicLand);
    if (!el) tone([392, 588], 0.085, 0.5);
  }

  /* ---------- session reset ---------- */

  function resetSession() {
    releaseSessionUrls();
    setPhase("idle");
    setPrediction({ blob: null, url: null, transcript: "" });
    setExplanation({ blob: null, url: null, transcript: "" });
    setFeedback(null);
    setFbState("idle");
    setSaveState("idle");
    setRevealedEarly(false);
    setLanded(false);
    setElapsed(0);
    setPriorEntry(null);
    setActiveTake(null);
    setTopicError(false);
    recorder.reset();
  }

  /* ---------- Encounter ---------- */

  function draw(targetId = null) {
    // A draw is in flight until its topic has resolved, not merely until the
    // reel stops. Both guards are refs so a second click in the same tick sees
    // the block before React has re-rendered.
    if (spinningRef.current || topicLoadingRef.current) return;
    resetSession();
    setTopic(null);

    const seq = ++drawSeqRef.current; // any earlier draw is now void
    spinningRef.current = true;
    pendingSeqRef.current = seq;

    const finalId = targetId ?? pickRandomId(seenIds);
    pendingTopicIdRef.current = finalId;

    const reel = reelTitles(REEL_LEN);
    const catEntry = catalogue.find((x) => x.id === finalId);
    reel[FINAL_IDX] = { id: finalId, title: catEntry?.title ?? "" };

    // Snapshot the geometry this spin will use, read fresh from the viewport,
    // and derive the transform target from that same number.
    const vp = readViewport();
    const snapSlotH = slotHeightFor(vp.w, vp.h);
    const snapLandY = (FINAL_IDX - 1) * snapSlotH;
    setLockedSlotH(snapSlotH);

    setReelItems(reel);
    setReelAnim(false);
    setReelY(0);
    setSpinning(true);

    startRollAudio(seq);

    const reduced = prefersReducedMotion();

    // transitionend drives the landing; this timer guarantees it happens even
    // when the transition is removed by prefers-reduced-motion.
    clearTimeout(settleRef.current);
    settleRef.current = setTimeout(
      () => settleReel(),
      reduced ? 90 : REEL_SPIN_MS + REEL_SETTLE_GRACE_MS
    );

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setReelAnim(!reduced);
        setReelY(-snapLandY);
      })
    );
  }

  async function settleReel() {
    if (!spinningRef.current) return; // already landed or abandoned
    const seq = pendingSeqRef.current;
    clearTimeout(settleRef.current);
    stopRollAudio();

    // The reel has finished but the session has not: hand straight over to an
    // explicit loading state so the application never looks like it returned
    // home while a topic request is still outstanding.
    spinningRef.current = false;
    topicLoadingRef.current = true;
    setSpinning(false);
    setTopicLoading(true);
    setReelAnim(false);
    setReelY(0);
    setLockedSlotH(null); // geometry follows the viewport again

    const id = pendingTopicIdRef.current;
    try {
      const [full, attempts] = await Promise.all([loadTopic(id), attemptCountFor(id)]);
      // Abandoned mid-load: whoever abandoned already cleared the loading state.
      if (drawSeqRef.current !== seq) return;
      topicLoadingRef.current = false;
      setTopicLoading(false);
      setTopic(full);
      setAttemptNumber(attempts + 1);
      setSeenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setLanded(true);
      playLandAudio();
    } catch {
      if (drawSeqRef.current !== seq) return;
      topicLoadingRef.current = false;
      setTopicLoading(false);
      setTopic(null);
      setTopicError(true);
    }
  }

  /* ---------- Home navigation ----------
     The session begins the moment a discovery is initiated: the reel counts,
     before a topic exists and while phase is still "idle". */

  const sessionInProgress = spinning || topicLoading || Boolean(topic);

  function goHome() {
    if (exitOpen) return;
    if (sessionInProgress) {
      setExitOpen(true);
      return;
    }
    hardReturnHome();
  }

  /* Deterministic return to a clean encounter state. Never calls saveEntry:
     an abandoned attempt must not become an archive record. */
  function hardReturnHome() {
    clearInterval(timerRef.current);
    clearInterval(tickRef.current);
    clearTimeout(settleRef.current);
    drawSeqRef.current += 1; // voids any pending landing, load, feedback or prior-attempt
    spinningRef.current = false;
    topicLoadingRef.current = false;
    setTopicLoading(false);
    setLockedSlotH(null);
    stopRollAudio();
    recorder.abort();

    resetSession(); // releases session object URLs
    setTopic(null);
    setSpinning(false);
    setReelItems([]);
    setReelAnim(false);
    setReelY(0);
    setAttemptNumber(1);
    setExitOpen(false);
    setArchiveOpen(false);
    setConfirmDeleteId(null);
    setPhase("idle");
  }

  /* ---------- Commit ---------- */

  function beginCommit() {
    setPhase("commit");
  }

  async function startPrediction() {
    const ok = await recorder.start();
    if (ok) setActiveTake("prediction");
  }

  function advanceAfterCommit() {
    if (mode === "cuff") {
      setPhase("ready");
      return;
    }
    setTimeLeft(MODES.deep.seconds);
    setPhase("research");
  }

  async function stopPrediction() {
    // The finalized transcript travels with the take; reading recorder.transcript
    // here would race the last SpeechRecognition result.
    const { blob, transcript } = await recorder.stop();
    if (blob) {
      // Only discard the previous take once a valid replacement exists.
      const nextUrl = trackUrl(blob);
      const oldUrl = prediction.url;
      setPrediction({ blob, url: nextUrl, transcript });
      releaseUrl(oldUrl);
    }
    setActiveTake(null);
    advanceAfterCommit();
  }

  function skipPrediction() {
    releaseUrl(prediction.url);
    setPrediction({ blob: null, url: null, transcript: "" });
    advanceAfterCommit();
  }

  /* ---------- Explain ---------- */

  async function startExplanation() {
    recorder.reset();
    const ok = await recorder.start();
    if (!ok) return;
    setActiveTake("explanation");
    speakStartRef.current = Date.now();
    setPhase("speak");
  }

  async function stopExplanation() {
    const { blob, transcript } = await recorder.stop();
    if (blob) {
      const nextUrl = trackUrl(blob);
      const oldUrl = explanation.url;
      setExplanation({ blob, url: nextUrl, transcript });
      releaseUrl(oldUrl);
    }
    setElapsed(speakStartRef.current ? (Date.now() - speakStartRef.current) / 60000 : 0);
    setActiveTake(null);

    // The previous attempt is revealed only on the next screen, never earlier.
    // It is fetched against the current draw so a slow lookup for an abandoned
    // topic cannot appear inside a later one.
    if (attemptNumber > 1) {
      const seq = drawSeqRef.current;
      const topicId = topic.id;
      previousAttempt(topicId)
        .then((entry) => { if (drawSeqRef.current === seq) setPriorEntry(entry); })
        .catch(() => { if (drawSeqRef.current === seq) setPriorEntry(null); });
    }
    setPhase("reveal");
  }

  /* ---------- Reveal ---------- */

  /* The AI service cannot be cancelled, so a superseded request is ignored on
     arrival instead: it must not overwrite a newer result, nor the loading or
     error state belonging to a newer request or a different topic. */
  async function loadFeedback() {
    if (fbState === "loading") return; // single-flight
    const reqSeq = ++fbSeqRef.current;
    const drawSeq = drawSeqRef.current;
    const stale = () => reqSeq !== fbSeqRef.current || drawSeq !== drawSeqRef.current;

    setFbState("loading");
    try {
      const fb = await requestFeedback({
        topic,
        predictionTranscript: prediction.transcript,
        explanationTranscript: explanation.transcript,
      });
      if (stale()) return;
      setFeedback(fb);
      setFbState("idle");
    } catch {
      if (stale()) return;
      setFbState("error");
    }
  }

  /* ---------- Preserve ----------
     On failure the user stays on the reveal screen with the recording intact
     and can retry. Nothing is cleared before persistence succeeds. */

  async function preserve() {
    if (saveState === "saving") return; // a second click must not duplicate
    setSaveState("saving");
    try {
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
    } catch {
      setSaveState("error");
      return;
    }
    await refreshArchive();
    resetSession();
    setTopic(null);
    setPrevTopicId(null);
    setPhase("saved");
  }

  /* ---------- Archive actions ---------- */

  async function removeEntry(id) {
    try {
      await deleteEntry(id); // removes the record and its blobs
      setConfirmDeleteId(null);
      await refreshArchive();
    } catch {
      setArchiveError("That entry could not be deleted. Please try again.");
    }
  }

  async function doExport() {
    try {
      const { manifest, audio } = await exportArchive();
      downloadBlob(manifest, "curio-archive.json");
      audio.forEach((f, i) => setTimeout(() => downloadBlob(f.blob, f.name), i * 250));
    } catch {
      setArchiveError("Export failed. Please try again.");
    }
  }

  /* Stable identities: the focus trap depends on these, and a new function on
     every render would tear the trap down and rebuild it continuously. */
  const closeArchive = useCallback(() => {
    setArchiveOpen(false);
    setConfirmDeleteId(null);
  }, []);

  const closeExit = useCallback(() => {
    setExitOpen(false);
  }, []);

  // Focus containment, Escape, and focus return to the opener.
  useFocusTrap(exitOpen, modalRef, closeExit);
  useFocusTrap(archiveOpen, drawerRef, closeArchive);

  /* ---------- derived view state ---------- */

  const rm = topic?.reference_material;
  const quietStage = Boolean(topic) && QUIET_PHASES.includes(phase);
  const stageArt = spinning
    ? CURIO_ASSETS.rolling
    : entries.length > 0
      ? CURIO_ASSETS.knowledgeBook // knowledge uncovered and preserved
      : CURIO_ASSETS.home; // knowledge still hidden

  const stats = useMemo(() => {
    if (phase !== "reveal" || !explanation.transcript) return null;
    const words = explanation.transcript.trim().split(/\s+/).filter(Boolean);
    const mins = Math.max(elapsed, 0.05);
    const low = explanation.transcript.toLowerCase();
    return {
      words: words.length,
      wpm: Math.round(words.length / mins),
      fillers: FILLERS.reduce((s, f) => s + (low.split(f).length - 1), 0),
    };
  }, [phase, explanation.transcript, elapsed]);

  const spokenFor =
    elapsed < 1 ? `${Math.round(elapsed * 60)} seconds` : `${elapsed.toFixed(1)} minutes`;

  const micMessage = recorder.error ? MIC_MESSAGES[recorder.error] : null;

  return (
    <div
      className="curio-root"
      data-theme={theme}
      style={{ "--c-slot": `${slotH}px` }}
    >
      <BackgroundStage art={stageArt} quiet={quietStage} />

      <div className="curio-shell">
        <header className="curio-masthead">
          <button
            type="button"
            className="curio-wordmark"
            data-wordmark="Curio"
            onClick={goHome}
            aria-label={sessionInProgress ? "Leave this session and return home" : "Curio home"}
          >
            Curio
          </button>

          <div className="curio-navgroup">
            <button
              type="button"
              className="curio-btn curio-btn--icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
            </button>

            <button
              type="button"
              className="curio-btn curio-btn--nav"
              onClick={() => setArchiveOpen(true)}
              aria-label={`Your archive, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
            >
              <Archive size={15} aria-hidden="true" />
              <span aria-hidden="true">{entries.length}</span>
            </button>
          </div>
        </header>

        <main className="curio-canvas">
          {/* ------------------ Encounter (home) ------------------ */}
          {!topic && !spinning && !topicLoading && (
            <div className="curio-rise-1">
              <div className="curio-modes" role="group" aria-label="Session mode">
                {Object.entries(MODES).map(([k, m]) => (
                  <button
                    key={k}
                    type="button"
                    className="curio-mode"
                    aria-pressed={mode === k}
                    onClick={() => setMode(k)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <p className="curio-invitation">{MODES[mode].sub}</p>

              {phase === "saved" && (
                <p className="curio-saved-note" role="status">Saved to your archive.</p>
              )}

              {topicError && (
                <p className="curio-notice curio-notice--danger" role="alert">
                  That discovery could not be loaded. Please draw again.
                </p>
              )}

              {archiveError && (
                <p className="curio-notice curio-notice--danger" role="alert">{archiveError}</p>
              )}

              <button
                type="button"
                className="curio-btn curio-btn--primary curio-btn--cta"
                onClick={() => draw()}
              >
                Draw today&apos;s discovery
              </button>

              {dueReturns.length > 0 && (
                <button
                  type="button"
                  className="curio-btn curio-btn--ghost curio-btn--block"
                  onClick={() => draw(dueReturns[0].topic_id)}
                >
                  <RotateCcw size={15} aria-hidden="true" /> Revisit {dueReturns[0].title}
                </button>
              )}
            </div>
          )}

          {/* ------------------ Drawing ------------------ */}
          {spinning && (
            <div>
              <p className="curio-eyebrow curio-eyebrow--gold" role="status">DRAWING</p>
              <div className="curio-reel">
                <div className="curio-reel__window" />
                <div className="curio-reel__fade" />
                <div
                  className="curio-reel__strip"
                  onTransitionEnd={settleReel}
                  style={{
                    transform: `translateY(${reelY}px)`,
                    transition: reelAnim
                      ? `transform ${REEL_SPIN_MS}ms cubic-bezier(.06,.7,.14,1)`
                      : "none",
                  }}
                >
                  {reelItems.map((x, i) => (
                    <div key={`${x.id}-${i}`} className="curio-reel__slot">
                      <span className="curio-reel__title">{x.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ------------------ Loading the drawn topic ------------------ */}
          {topicLoading && (
            <div className="curio-center">
              <p className="curio-eyebrow curio-eyebrow--gold curio-breathe" role="status">
                FINDING IT
              </p>
            </div>
          )}

          {/* ------------------ Topic ------------------ */}
          {topic && !spinning && !topicLoading && (
            <div>
              <p className="curio-eyebrow curio-eyebrow--gold curio-rise-1">
                {attemptNumber > 1 ? `RETURN \u00B7 ATTEMPT ${attemptNumber}` : "TODAY'S DISCOVERY"}
              </p>

              <h1 className={`curio-title${landed ? " curio-settle" : ""}`}>{topic.title}</h1>

              <p className="curio-hook curio-rise-2">{topic.hook}</p>

              {/* --- idle: begin --- */}
              {phase === "idle" && (
                <div className="curio-rise-3">
                  <button
                    type="button"
                    className="curio-btn curio-btn--primary curio-btn--block"
                    onClick={beginCommit}
                  >
                    Make your guess
                  </button>
                  <div className="curio-actions curio-actions--spaced">
                    <button type="button" className="curio-btn curio-btn--ghost" onClick={() => draw()}>
                      <RotateCcw size={15} aria-hidden="true" /> Draw another
                    </button>
                    <button
                      type="button"
                      className="curio-btn curio-btn--ghost curio-btn--hold"
                      onClick={goHome}
                    >
                      <ChevronLeft size={15} aria-hidden="true" /> Back
                    </button>
                  </div>
                </div>
              )}

              {/* --- commit --- */}
              {phase === "commit" && (
                <div className="curio-rise-1">
                  <p className="curio-eyebrow curio-eyebrow--inline">BEFORE YOU LOOK ANYTHING UP</p>
                  <p className="curio-lead">{topic.prediction_prompt}</p>

                  {micMessage && (
                    <p className="curio-notice" role="alert">{micMessage}</p>
                  )}

                  {activeTake === "prediction" ? (
                    <div className="curio-center">
                      <p className="curio-eyebrow curio-recording curio-breathe" role="status">
                        <span className="curio-recording__dot" aria-hidden="true" />
                        RECORDING YOUR GUESS
                      </p>
                      {recorder.transcript && (
                        <div className="curio-transcript">{recorder.transcript}</div>
                      )}
                      <button
                        type="button"
                        className="curio-btn curio-btn--stop"
                        onClick={stopPrediction}
                        aria-label="Stop recording your guess"
                      >
                        <Square size={21} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <div className="curio-stack">
                      <button
                        type="button"
                        className="curio-btn curio-btn--primary curio-btn--block"
                        onClick={startPrediction}
                      >
                        <Mic size={17} aria-hidden="true" /> Record my guess
                      </button>
                      <button
                        type="button"
                        className="curio-btn curio-btn--subtle curio-btn--block"
                        onClick={skipPrediction}
                      >
                        Skip the guess
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* --- research: reference_material only, never the briefing --- */}
              {phase === "research" && (
                <div className="curio-rise-1">
                  <div className="curio-research-head">
                    <span className="curio-eyebrow curio-eyebrow--inline">RESEARCH IT YOURSELF</span>
                    <span className="curio-timer" role="timer" aria-label={`${timeLeft} seconds remaining`}>
                      {fmt(timeLeft)}
                    </span>
                  </div>

                  {rm?.names?.length > 0 && (
                    <section className="curio-block">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">NAMES</h2>
                      <div className="curio-chips">
                        {rm.names.map((x) => (
                          <span key={x} className="curio-chip">{x}</span>
                        ))}
                      </div>
                    </section>
                  )}

                  {rm?.timeline?.length > 0 && (
                    <section className="curio-block">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">WHEN</h2>
                      {rm.timeline.map((x) => (
                        <p key={x} className="curio-timeline-item">{x}</p>
                      ))}
                    </section>
                  )}

                  {rm?.terms?.length > 0 && (
                    <section className="curio-block">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">LOOK THESE UP</h2>
                      <div className="curio-chips">
                        {rm.terms.map((x) => (
                          <span key={x} className="curio-chip curio-chip--term">{x}</span>
                        ))}
                      </div>
                    </section>
                  )}

                  {rm?.research_threads?.length > 0 && (
                    <section className="curio-rule">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">QUESTIONS TO CHASE</h2>
                      {rm.research_threads.map((x) => (
                        <p key={x} className="curio-question">{x}</p>
                      ))}
                    </section>
                  )}

                  {revealedEarly && (
                    <section className="curio-card">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">THE BRIEFING</h2>
                      <p className="curio-prose">{topic.briefing}</p>
                    </section>
                  )}

                  <div className="curio-stack">
                    <button
                      type="button"
                      className="curio-btn curio-btn--primary curio-btn--block"
                      onClick={() => { clearInterval(timerRef.current); setPhase("ready"); }}
                    >
                      I&apos;m ready to explain
                    </button>
                    {!revealedEarly && (
                      <button
                        type="button"
                        className="curio-btn curio-btn--subtle curio-btn--block"
                        onClick={() => setRevealedEarly(true)}
                      >
                        I&apos;m stuck — show me the briefing
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* --- ready --- */}
              {phase === "ready" && (
                <div className="curio-rise-1 curio-stack">
                  <button
                    type="button"
                    className="curio-btn curio-btn--primary curio-btn--block"
                    onClick={startExplanation}
                  >
                    <Mic size={17} aria-hidden="true" /> Explain it in your own words
                  </button>
                  {mode === "deep" && (
                    <button
                      type="button"
                      className="curio-btn curio-btn--subtle curio-btn--block"
                      onClick={() => setPhase("research")}
                    >
                      Back to research
                    </button>
                  )}
                  {micMessage && <p className="curio-notice" role="alert">{micMessage}</p>}
                </div>
              )}

              {/* --- explain --- */}
              {phase === "speak" && (
                <div className="curio-center">
                  <p className="curio-eyebrow curio-recording curio-breathe" role="status">
                    <span className="curio-recording__dot" aria-hidden="true" />
                    RECORDING
                  </p>
                  {recorder.transcript && (
                    <div className="curio-transcript">{recorder.transcript}</div>
                  )}
                  <button
                    type="button"
                    className="curio-btn curio-btn--stop"
                    onClick={stopExplanation}
                    aria-label="Stop recording your explanation"
                  >
                    <Square size={21} aria-hidden="true" />
                  </button>
                </div>
              )}

              {/* --- reveal: the only place misconception and briefing appear --- */}
              {phase === "reveal" && (
                <div className="curio-rise-1">
                  <p className="curio-center curio-lead">You spoke for {spokenFor}.</p>

                  {stats && (
                    <p className="curio-center curio-muted curio-stat">
                      {stats.words} words &middot; {stats.wpm} per minute &middot;{" "}
                      {stats.fillers} filler{stats.fillers === 1 ? "" : "s"}
                    </p>
                  )}

                  <section className="curio-card curio-card--gold">
                    <h2 className="curio-eyebrow curio-eyebrow--inline">MOST PEOPLE THINK</h2>
                    <p className="curio-prose">{topic.misconception}</p>
                  </section>

                  <section className="curio-card curio-card--accent">
                    <h2 className="curio-eyebrow curio-eyebrow--inline">WHAT IS ACTUALLY KNOWN</h2>
                    <p className="curio-prose">{topic.briefing}</p>
                  </section>

                  {prediction.url && (
                    <section className="curio-block">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">YOUR GUESS</h2>
                      <audio controls src={prediction.url} />
                    </section>
                  )}

                  {explanation.url && (
                    <section className="curio-block">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">YOUR EXPLANATION</h2>
                      <audio controls src={explanation.url} />
                    </section>
                  )}

                  {priorEntry && (
                    <section className="curio-card curio-card--quiet">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">
                        YOU EXPLAINED THIS ON{" "}
                        {new Date(priorEntry.created_at).toLocaleDateString()}
                      </h2>
                      {priorEntry.explanation?.transcript && (
                        <p className="curio-entry__transcript">
                          {priorEntry.explanation.transcript}
                        </p>
                      )}
                    </section>
                  )}

                  {aiAvailable() && !feedback && fbState !== "loading" && explanation.transcript && (
                    <button
                      type="button"
                      className="curio-btn curio-btn--gold curio-btn--block"
                      onClick={loadFeedback}
                    >
                      <Sparkles size={15} aria-hidden="true" /> How did I do?
                    </button>
                  )}
                  {fbState === "loading" && (
                    <p className="curio-center curio-breathe curio-loading" role="status">
                      Listening closely…
                    </p>
                  )}
                  {fbState === "error" && (
                    <p className="curio-notice" role="alert">
                      Feedback did not load. Your recording is safe — you can save and try later.
                    </p>
                  )}

                  {feedback && (
                    <div className="curio-block">
                      {feedback.encouragement && (
                        <p className="curio-center curio-lead">{feedback.encouragement}</p>
                      )}
                      {feedback.understanding && (
                        <section className="curio-card curio-card--accent">
                          <h2 className="curio-eyebrow curio-eyebrow--inline">DID YOU EXPLAIN IT?</h2>
                          <p className="curio-verdict">{feedback.understanding.verdict}</p>
                          <p className="curio-prose">
                            {feedback.understanding.detail}
                          </p>
                          {feedback.missed?.length > 0 && (
                            <>
                              <h3 className="curio-eyebrow curio-eyebrow--inline curio-eyebrow--spaced">
                                WORTH ADDING
                              </h3>
                              {feedback.missed.map((m) => (
                                <p key={m} className="curio-list-item">{m}</p>
                              ))}
                            </>
                          )}
                        </section>
                      )}
                      {feedback.fluency && (
                        <section className="curio-card curio-card--gold">
                          <h2 className="curio-eyebrow curio-eyebrow--inline">HOW YOU SOUNDED</h2>
                          <p className="curio-prose">{feedback.fluency}</p>
                        </section>
                      )}
                      {feedback.next_time && (
                        <section className="curio-rule">
                          <h2 className="curio-eyebrow curio-eyebrow--inline">NEXT TIME</h2>
                          <p className="curio-prose">{feedback.next_time}</p>
                        </section>
                      )}
                    </div>
                  )}

                  {topic.discussion_prompt && (
                    <section className="curio-rule curio-rule--muted">
                      <h2 className="curio-eyebrow curio-eyebrow--inline">THINK ABOUT</h2>
                      <p className="curio-question">
                        {topic.discussion_prompt}
                      </p>
                    </section>
                  )}

                  {saveState === "error" && (
                    <p className="curio-notice curio-notice--danger" role="alert">
                      Your entry could not be saved. Your recording is still here — please try again.
                    </p>
                  )}

                  <div className="curio-actions">
                    <button
                      type="button"
                      className="curio-btn curio-btn--primary"
                      onClick={preserve}
                      disabled={saveState === "saving"}
                      aria-busy={saveState === "saving"}
                    >
                      {saveState === "saving"
                        ? "Saving…"
                        : saveState === "error"
                          ? "Try saving again"
                          : "Save entry"}
                    </button>
                    <button
                      type="button"
                      className="curio-btn curio-btn--ghost curio-btn--hold"
                      onClick={() => draw()}
                      disabled={saveState === "saving"}
                    >
                      <RotateCcw size={15} aria-hidden="true" /> Another
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ------------------ Leave-session dialog ------------------ */}
      {exitOpen && (
        <div
          className="curio-modal"
          role="presentation"
          onClick={closeExit}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="curio-exit-title"
            tabIndex={-1}
            className="curio-modal__panel"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="curio-exit-title" className="curio-modal__title">Leave this session?</h2>
            <p className="curio-modal__body">
              You are part-way through {topic ? topic.title : "a discovery"}. Nothing from this
              attempt will be saved to your archive.
            </p>
            <div className="curio-actions">
              <button type="button" className="curio-btn curio-btn--primary" onClick={hardReturnHome}>
                Yes, leave
              </button>
              <button type="button" className="curio-btn curio-btn--ghost" onClick={closeExit}>
                No, keep going
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------ Archive ------------------ */}
      {archiveOpen && (
        <div className="curio-drawer-scrim" role="presentation" onClick={closeArchive}>
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="curio-archive-title"
            tabIndex={-1}
            className="curio-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="curio-drawer__head">
              <h2 id="curio-archive-title" className="curio-drawer__title">Your archive</h2>
              <button
                type="button"
                className="curio-btn curio-btn--icon"
                onClick={closeArchive}
                aria-label="Close archive"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            {archiveError && (
              <p className="curio-notice curio-notice--danger" role="alert">{archiveError}</p>
            )}

            {entries.length > 0 && (
              <button
                type="button"
                className="curio-btn curio-btn--ghost curio-btn--block curio-drawer__export"
                onClick={doExport}
              >
                <Download size={15} aria-hidden="true" /> Export everything
              </button>
            )}

            {entries.length === 0 && !archiveError && (
              <p className="curio-muted">
                Nothing saved yet. Draw a discovery and record your first entry.
              </p>
            )}

            {entries.map((e) => (
              <article key={e.id} className="curio-entry">
                <h3 className="curio-entry__title">{e.topic_title}</h3>
                <p className="curio-entry__meta">
                  {new Date(e.created_at).toLocaleString()} &middot;{" "}
                  {MODES[e.mode]?.label ?? e.mode}
                  {e.attempt_number > 1 ? ` \u00B7 attempt ${e.attempt_number}` : ""}
                </p>

                {entryUrls[e.id] && (
                  <audio controls src={entryUrls[e.id]} />
                )}

                {e.revealed_early && (
                  <p className="curio-entry__note">Briefing revealed during research</p>
                )}

                {confirmDeleteId === e.id ? (
                  <div className="curio-confirm">
                    <p className="curio-confirm__text">
                      Delete this entry permanently? The recording cannot be recovered.
                    </p>
                    <div className="curio-actions">
                      <button
                        type="button"
                        className="curio-btn curio-btn--danger"
                        onClick={() => removeEntry(e.id)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="curio-btn curio-btn--ghost"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="curio-btn curio-btn--subtle curio-btn--flush"
                    onClick={() => setConfirmDeleteId(e.id)}
                    aria-label={`Delete entry: ${e.topic_title}`}
                                      >
                    <Trash2 size={13} aria-hidden="true" /> Delete
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
