import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Mic, Square, Archive, X, Sparkles, Download, RotateCcw, ChevronLeft, SlidersHorizontal } from "lucide-react";

import topicsData from "./data/topics.json";

/* ============================================================
   Unprompted — discovery & speaking practice
   Single source of content truth: ./data/topics.json
   There is no inline topic data anywhere in this file.
   ============================================================ */

const ALL_TOPICS = topicsData.topics;
const CATEGORIES = topicsData.categories;

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
  cuff: { label: "Off the cuff", seconds: 120, sub: "Speak now. Think on your feet." },
  deep: { label: "Deep dive", seconds: 900, sub: "Read the briefing first, then speak." },
};

const FILLERS = ["um", "uh", "like", "you know", "so yeah", "basically", "actually"];

const SLOT_H = 84;
const REEL_LEN = 30;
const FINAL_IDX = REEL_LEN - 2;           // chosen term sits one slot from the end
const LAND_Y = (FINAL_IDX - 1) * SLOT_H;  // so it settles in the CENTRE slot, term above and below

const MODEL = "claude-sonnet-4-6";

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
    /* audio is decorative; never block the session */
  }
}

async function askClaude(prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => b.text || "")
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(text);
}

export default function Unprompted() {
  const [themeName, setThemeName] = useState("dark");
  const t = THEMES[themeName];

  const [catFilter, setCatFilter] = useState("ALL");
  const [showFilter, setShowFilter] = useState(false);

  const [topic, setTopic] = useState(null);
  const [prevTopic, setPrevTopic] = useState(null);
  const [briefings, setBriefings] = useState({}); // id -> generated briefing cache
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState(false);

  const [spinning, setSpinning] = useState(false);
  const [reelItems, setReelItems] = useState([]);
  const [reelY, setReelY] = useState(0);
  const [reelAnim, setReelAnim] = useState(false);
  const [landed, setLanded] = useState(false);

  const [mode, setMode] = useState("deep");
  const [phase, setPhase] = useState("idle");
  const [timeLeft, setTimeLeft] = useState(MODES.deep.seconds);

  const [audioURL, setAudioURL] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [speakStart, setSpeakStart] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState(false);

  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const [fb, setFb] = useState(null);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError, setFbError] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const timerRef = useRef(null);
  const tickRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const srRef = useRef(null);
  const urlsRef = useRef([]);

  const pool = useMemo(
    () => (catFilter === "ALL" ? ALL_TOPICS : ALL_TOPICS.filter((x) => x.cat === catFilter)),
    [catFilter]
  );

  const pick = useCallback(() => pool[Math.floor(Math.random() * pool.length)], [pool]);

  useEffect(() => {
    if (phase !== "research" && phase !== "speak") return;
    timerRef.current = setInterval(() => {
      setTimeLeft((x) => {
        if (x <= 1) {
          clearInterval(timerRef.current);
          if (phase === "research") setPhase("ready");
          return 0;
        }
        return x - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [phase]);

  useEffect(
    () => () => {
      clearInterval(tickRef.current);
      clearInterval(timerRef.current);
      try {
        recRef.current?.stop();
        srRef.current?.stop();
      } catch (e) {}
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    []
  );

  function resetSession() {
    setPhase("idle");
    setAudioURL(null);
    setTranscript("");
    setFb(null);
    setFbError(false);
    setBriefError(false);
    setLanded(false);
    setElapsed(0);
  }

  function spin() {
    if (topic) setPrevTopic(topic);
    resetSession();
    setTopic(null);

    const final = pick();
    const reel = Array.from({ length: REEL_LEN }, () => pick());
    reel[FINAL_IDX] = final;

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

  function onReelEnd() {
    if (!spinning) return;
    clearInterval(tickRef.current);
    setTopic(reelItems[FINAL_IDX]);
    setSpinning(false);
    setReelAnim(false);
    setReelY(0);
    setLanded(true);
    tone([392, 588], 0.085, 0.5);
  }

  function goBack() {
    if (!prevTopic) return;
    resetSession();
    setTopic(prevTopic);
    setPrevTopic(null);
    setLanded(true);
  }

  // Briefing: pre-written when enriched, generated on demand and cached otherwise.
  const brief = topic ? (topic.enriched ? topic : briefings[topic.id]) : null;

  async function ensureBriefing(current) {
    if (!current || current.enriched || briefings[current.id]) return;
    setBriefLoading(true);
    setBriefError(false);
    try {
      const data = await askClaude(
        `Write a research briefing for a discovery-and-speaking app. Audience ranges from children to adults. Strictly age-appropriate: nothing graphic, gory or frightening.

TOPIC: "${current.title}"
KNOWN HOOK: "${current.hook}"

Write with real substance and no filler. Respond with ONLY raw JSON, no fences:
{
  "summary": "3-4 sentences explaining what this is and why it is remarkable",
  "facts": ["three specific surprising verifiable points", "second", "third"],
  "vocab": [{"word":"...","meaning":"one simple line"},{"word":"...","meaning":"..."},{"word":"...","meaning":"..."}],
  "question": "one open discussion question with no single right answer"
}
Exactly 3 facts and exactly 3 vocab items.`,
        1200
      );
      setBriefings((b) => ({ ...b, [current.id]: { ...current, ...data } }));
    } catch (e) {
      setBriefError(true);
    }
    setBriefLoading(false);
  }

  function startResearch() {
    setTimeLeft(MODES[mode].seconds);
    if (mode === "cuff") {
      setPhase("ready");
      return;
    }
    setPhase("research");
    ensureBriefing(topic);
  }

  async function startRecording() {
    setMicError(false);
    setTranscript("");
    setFb(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        const url = URL.createObjectURL(new Blob(chunksRef.current, { type: "audio/webm" }));
        urlsRef.current.push(url);
        setAudioURL(url);
        stream.getTracks().forEach((x) => x.stop());
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

      setSpeakStart(Date.now());
      setElapsed(0);
      setPhase("speak");
      tone([523], 0.05, 0.12);
    } catch (e) {
      setMicError(true);
    }
  }

  function stopRecording() {
    try {
      recRef.current?.stop();
      srRef.current?.stop();
    } catch (e) {}
    setElapsed(speakStart ? (Date.now() - speakStart) / 60000 : 0);
    setPhase("done");
    tone([440], 0.05, 0.18);
  }

  const stats = useMemo(() => {
    if (phase !== "done" || !transcript) return null;
    const words = transcript.trim().split(/\s+/).filter(Boolean);
    const mins = Math.max(elapsed, 0.05);
    const low = transcript.toLowerCase();
    return {
      words: words.length,
      mins,
      wpm: Math.round(words.length / mins),
      fillers: FILLERS.reduce((s, f) => s + (low.split(f).length - 1), 0),
    };
  }, [phase, transcript, elapsed]);

  async function getFeedback() {
    if (!transcript || transcript.trim().length < 3) return;
    setFbLoading(true);
    setFbError(false);
    try {
      const data = await askClaude(
        `A learner just spoke aloud explaining a topic. Judge warmly and specifically.

TOPIC: "${topic.title}"
WHAT IT IS ACTUALLY ABOUT: "${brief?.summary || topic.hook}"
WHAT THEY SAID (speech transcript — ignore punctuation and capitalisation): "${transcript}"

Write in warm, plain language a 10-year-old could follow, but detailed enough to genuinely teach. Never harsh. Always name a real strength first.

Respond with ONLY raw JSON, no fences:
{
  "encouragement": "2 warm sentences naming something they genuinely did well",
  "understanding": {"verdict":"short phrase, e.g. 'Explained it clearly' or 'Got the idea, missed the why'","detail":"2-3 sentences on whether they really explained it and what a listener would take away"},
  "missed": ["a key point they did not mention"],
  "fluency": "2 sentences on flow, pace and confidence",
  "grammar": [{"original":"phrase as said","corrected":"fixed","why":"one plain sentence"}],
  "nextTime": "one specific encouraging thing to try next session"
}
At most 2 items in "missed" and 3 in "grammar". Return an empty grammar array if it was fine.`,
        1200
      );
      setFb(data);
    } catch (e) {
      setFbError(true);
    }
    setFbLoading(false);
  }

  function save() {
    setHistory((h) => [
      { topic, mode, transcript, audioURL, when: new Date().toLocaleString(), s: stats, fb },
      ...h,
    ]);
    resetSession();
    setTopic(null);
    setPrevTopic(null);
  }

  async function generateNew() {
    setAiLoading(true);
    try {
      const catKey = catFilter === "ALL"
        ? CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)].key
        : catFilter;
      const catMeta = CATEGORIES.find((c) => c.key === catKey);
      const avoid = ALL_TOPICS.filter((x) => x.cat === catKey).map((x) => x.title).slice(0, 25).join(", ");

      const data = await askClaude(
        `Create ONE topic for a discovery-and-speaking app. Audience ranges from children to adults. Strictly age-appropriate: nothing graphic, gory or frightening.

CATEGORY: ${catMeta.label} — ${catMeta.description}

CONTENT STANDARD (this matters most):
- It must be genuinely obscure. Not something a casual search would surface first. Avoid famous textbook examples.
- title: a short evocative term, 2-5 words, like a museum label. Never a sentence.
- hook: ONE sentence that creates emotion BEFORE information — it should make someone think "wait, really?". Open like a documentary, never like an encyclopedia. Do not simply state the fact plainly.
- summary: 3-4 substantial sentences.
- facts: exactly 3 specific, surprising, verifiable points.
- vocab: exactly 3 useful words with simple one-line meanings.
- question: one open discussion question with no single right answer.

Avoid these existing titles: ${avoid}

Respond with ONLY raw JSON:
{"title":"...","hook":"...","summary":"...","facts":["...","...","..."],"vocab":[{"word":"...","meaning":"..."},{"word":"...","meaning":"..."},{"word":"...","meaning":"..."}],"question":"..."}`,
        1400
      );

      if (topic) setPrevTopic(topic);
      resetSession();
      setTopic({ id: `AI-${Date.now()}`, cat: catKey, enriched: true, aiGenerated: true, ...data });
      setLanded(true);
      tone([392, 588], 0.085, 0.5);
    } catch (e) {
      spin();
    }
    setAiLoading(false);
  }

  const base = {
    fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
    cursor: "pointer",
    minHeight: 48,
    transition: "opacity .18s, transform .12s, background .2s, border-color .2s",
  };
  const primary = { ...base, background: t.accent, color: t.onAccent, border: "none", borderRadius: 14, fontWeight: 700 };
  const ghost = { ...base, background: "transparent", color: t.text, border: `1px solid ${t.line}`, borderRadius: 14 };
  const eyebrow = { fontSize: 11.5, letterSpacing: ".2em", color: t.muted, fontWeight: 700 };

  const activeCat = catFilter === "ALL" ? null : CATEGORIES.find((c) => c.key === catFilter);

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
        @media (prefers-reduced-motion: reduce) { .settle,.r1,.r2,.r3,.breathe { animation: none !important; } }
      `}</style>

      <div style={{ maxWidth: 520, margin: "0 auto", padding: "18px 20px 70px" }}>
        {/* masthead */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 30 }}>
          <div className="disp" style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.015em" }}>
            Unprompted
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
              aria-label="Your entries"
              onClick={() => setShowHistory(true)}
              style={{ ...ghost, minHeight: 40, borderRadius: 999, padding: "0 15px", display: "flex", alignItems: "center", gap: 7, fontSize: 14 }}
            >
              <Archive size={15} /> {history.length}
            </button>
          </div>
        </div>

        {/* ---------------- IDLE ---------------- */}
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
            <div style={{ fontSize: 14, color: t.muted, textAlign: "center", marginBottom: 22 }}>{MODES[mode].sub}</div>

            {/* collection filter */}
            <button
              className="tap"
              onClick={() => setShowFilter((v) => !v)}
              style={{ ...ghost, width: "100%", minHeight: 46, padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 14.5, marginBottom: showFilter ? 10 : 26 }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <SlidersHorizontal size={15} />
                {activeCat ? activeCat.label : "Every collection"}
              </span>
              <span style={{ color: t.muted, fontSize: 13 }}>{pool.length}</span>
            </button>

            {showFilter && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 26 }}>
                {[{ key: "ALL", label: "Everything" }, ...CATEGORIES].map((c) => (
                  <button
                    key={c.key}
                    className="tap"
                    onClick={() => { setCatFilter(c.key); setShowFilter(false); }}
                    style={{ ...base, minHeight: 38, borderRadius: 999, padding: "0 14px", fontSize: 13.5, fontWeight: 700, border: `1px solid ${catFilter === c.key ? t.accent : t.line}`, background: catFilter === c.key ? t.accent : "transparent", color: catFilter === c.key ? t.onAccent : t.muted }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}

            <button className="tap" onClick={spin} style={{ ...primary, width: "100%", padding: "26px 20px", fontSize: 17, marginBottom: 10 }}>
              Draw today's discovery
            </button>
            <button
              className="tap"
              onClick={generateNew}
              disabled={aiLoading}
              style={{ ...base, width: "100%", background: "transparent", color: t.amber, border: `1px dashed ${t.amber}55`, borderRadius: 14, padding: 15, fontSize: 14.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              <Sparkles size={15} /> {aiLoading ? "Finding something new…" : "Generate something new"}
            </button>
          </div>
        )}

        {/* ---------------- REEL ---------------- */}
        {spinning && (
          <div>
            <div style={{ ...eyebrow, textAlign: "center", color: t.amber, marginBottom: 20 }}>DRAWING</div>
            <div style={{ position: "relative", height: SLOT_H * 3, overflow: "hidden" }}>
              <div style={{ position: "absolute", top: SLOT_H, left: 0, right: 0, height: SLOT_H, borderTop: `1px solid ${t.accent}66`, borderBottom: `1px solid ${t.accent}66`, zIndex: 3, pointerEvents: "none" }} />
              <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none", background: `linear-gradient(180deg, ${t.flat} 0%, ${t.flat}00 30%, ${t.flat}00 70%, ${t.flat} 100%)` }} />
              <div
                onTransitionEnd={onReelEnd}
                style={{ transform: `translateY(${reelY}px)`, transition: reelAnim ? "transform 3.1s cubic-bezier(.06,.7,.14,1)" : "none" }}
              >
                {reelItems.map((x, i) => (
                  <div key={`${x.id}-${i}`} style={{ height: SLOT_H, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 14px" }}>
                    <span className="disp" style={{ fontSize: 24, fontWeight: 500, textAlign: "center", lineHeight: 1.1 }}>{x.title}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- TOPIC ---------------- */}
        {topic && !spinning && (
          <div>
            <div className="r1" style={{ ...eyebrow, textAlign: "center", color: t.amber, marginBottom: 18, display: "flex", justifyContent: "center", alignItems: "center", gap: 7 }}>
              TODAY'S DISCOVERY {topic.aiGenerated && <Sparkles size={12} />}
            </div>

            <h1 className={`disp ${landed ? "settle" : ""}`} style={{ textAlign: "center", fontSize: 41, fontWeight: 500, lineHeight: 1.07, margin: "0 0 18px" }}>
              {topic.title}
            </h1>

            <p className="r2" style={{ textAlign: "center", fontSize: 17, color: t.muted, lineHeight: 1.62, maxWidth: 400, margin: "0 auto 34px" }}>
              {topic.hook}
            </p>

            {phase === "idle" && (
              <div className="r3">
                <button className="tap" onClick={startResearch} style={{ ...primary, width: "100%", padding: 17, fontSize: 16, marginBottom: 10 }}>
                  {mode === "cuff" ? "Start speaking" : "Read the briefing"}
                </button>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={spin} style={{ ...ghost, flex: 1, padding: 14, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Draw another
                  </button>
                  {prevTopic && (
                    <button className="tap" onClick={goBack} style={{ ...ghost, padding: "14px 18px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <ChevronLeft size={15} /> Back
                    </button>
                  )}
                </div>
              </div>
            )}

            {phase === "research" && (
              <div className="r1">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
                  <span style={eyebrow}>BRIEFING</span>
                  <span className="disp" style={{ fontSize: 26, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmt(timeLeft)}</span>
                </div>

                {briefLoading && (
                  <p className="breathe" style={{ fontSize: 15.5, color: t.amber, fontWeight: 700, margin: "0 0 20px" }}>
                    Preparing your briefing…
                  </p>
                )}

                {briefError && !brief && (
                  <div style={{ marginBottom: 22 }}>
                    <p style={{ fontSize: 15, color: t.amber, lineHeight: 1.55, margin: "0 0 10px" }}>
                      The briefing didn't load. You can still research this yourself and speak.
                    </p>
                    <button className="tap" onClick={() => ensureBriefing(topic)} style={{ ...ghost, padding: "11px 16px", fontSize: 14 }}>
                      Try again
                    </button>
                  </div>
                )}

                {brief?.summary && (
                  <p style={{ fontSize: 16, lineHeight: 1.68, margin: "0 0 24px" }}>{brief.summary}</p>
                )}

                {brief?.facts?.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ ...eyebrow, marginBottom: 12 }}>WORTH KNOWING</div>
                    {brief.facts.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 15.5, lineHeight: 1.6 }}>
                        <span className="disp" style={{ color: t.accent, fontSize: 15, minWidth: 16 }}>{i + 1}</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                )}

                {brief?.vocab?.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ ...eyebrow, marginBottom: 12 }}>WORDS TO USE</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {brief.vocab.map((v, i) => (
                        <div key={i} style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 10, padding: "11px 14px" }}>
                          <span className="disp" style={{ fontSize: 16.5, fontWeight: 600, color: t.accent }}>{v.word}</span>
                          <span style={{ fontSize: 14.5, color: t.muted }}> — {v.meaning}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {brief?.question && (
                  <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16, marginBottom: 28 }}>
                    <div style={{ ...eyebrow, marginBottom: 8 }}>THINK ABOUT</div>
                    <p className="disp" style={{ fontSize: 18.5, lineHeight: 1.45, margin: 0, fontStyle: "italic" }}>{brief.question}</p>
                  </div>
                )}

                <button
                  className="tap"
                  onClick={() => { clearInterval(timerRef.current); setPhase("ready"); }}
                  style={{ ...primary, width: "100%", padding: 17, fontSize: 16 }}
                >
                  I'm ready to speak
                </button>
              </div>
            )}

            {phase === "ready" && !micError && (
              <div className="r1">
                <button className="tap" onClick={startRecording} style={{ ...primary, width: "100%", padding: 18, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10 }}>
                  <Mic size={17} /> Start recording
                </button>
                {mode === "deep" && (
                  <button className="tap" onClick={() => setPhase("research")} style={{ ...ghost, width: "100%", padding: 13, fontSize: 14 }}>
                    Back to briefing
                  </button>
                )}
              </div>
            )}

            {micError && (
              <div style={{ fontSize: 15, color: t.amber, textAlign: "center", lineHeight: 1.55, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16 }}>
                Recording needs microphone access. Allow it in your browser settings, then try again.
              </div>
            )}

            {phase === "speak" && (
              <div style={{ textAlign: "center" }}>
                <div className="breathe" style={{ ...eyebrow, color: t.amber, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.amber }} /> RECORDING
                </div>
                {transcript && (
                  <div style={{ fontSize: 15, color: t.muted, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 15, marginBottom: 18, textAlign: "left", maxHeight: 120, overflowY: "auto", lineHeight: 1.6 }}>
                    {transcript}
                  </div>
                )}
                <button
                  className="tap"
                  onClick={stopRecording}
                  aria-label="Stop recording"
                  style={{ ...base, background: t.text, color: t.flat, border: "none", borderRadius: "50%", width: 70, height: 70, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  <Square size={21} />
                </button>
              </div>
            )}

            {phase === "done" && (
              <div className="r1">
                {stats && (
                  <div style={{ textAlign: "center", marginBottom: 22 }}>
                    <p className="disp" style={{ fontSize: 21, lineHeight: 1.45, margin: 0, fontWeight: 500 }}>
                      You spoke for {stats.mins < 1 ? `${Math.round(stats.mins * 60)} seconds` : `${stats.mins.toFixed(1)} minutes`} about {topic.title}.
                    </p>
                    <p style={{ fontSize: 15, color: t.muted, marginTop: 8 }}>
                      {stats.words} words · {stats.wpm} per minute · {stats.fillers} filler{stats.fillers === 1 ? "" : "s"}
                    </p>
                  </div>
                )}

                {audioURL && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
                    <audio controls src={audioURL} style={{ flex: 1, height: 40 }} />
                    <a
                      href={audioURL}
                      download={`${topic.title.replace(/\s+/g, "-")}.webm`}
                      className="tap"
                      aria-label="Download recording"
                      style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 12, display: "flex", color: t.text }}
                    >
                      <Download size={16} />
                    </a>
                  </div>
                )}

                {!fb && !fbLoading && transcript && (
                  <button
                    className="tap"
                    onClick={getFeedback}
                    style={{ ...base, width: "100%", background: "transparent", border: `1px dashed ${t.amber}55`, color: t.amber, borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                  >
                    <Sparkles size={15} /> How did I do?
                  </button>
                )}
                {fbLoading && <div className="breathe" style={{ textAlign: "center", fontSize: 15, color: t.amber, fontWeight: 700, marginBottom: 16 }}>Listening closely…</div>}
                {fbError && <div style={{ fontSize: 14.5, color: t.amber, textAlign: "center", marginBottom: 16 }}>Feedback didn't load. Check your connection and try again.</div>}

                {fb && (
                  <div style={{ marginBottom: 18 }}>
                    {fb.encouragement && (
                      <p className="disp" style={{ fontSize: 18, lineHeight: 1.55, margin: "0 0 20px", textAlign: "center" }}>{fb.encouragement}</p>
                    )}

                    {fb.understanding && (
                      <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.accent}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
                        <div style={{ ...eyebrow, marginBottom: 8 }}>DID YOU EXPLAIN IT?</div>
                        <div className="disp" style={{ fontSize: 18, fontWeight: 600, color: t.accent, marginBottom: 8 }}>{fb.understanding.verdict}</div>
                        <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>{fb.understanding.detail}</p>
                        {fb.missed?.length > 0 && (
                          <div style={{ marginTop: 14 }}>
                            <div style={{ ...eyebrow, marginBottom: 8 }}>WORTH ADDING</div>
                            {fb.missed.map((m, i) => (
                              <div key={i} style={{ fontSize: 14.5, color: t.muted, lineHeight: 1.55, marginTop: 6, paddingLeft: 14, position: "relative" }}>
                                <span style={{ position: "absolute", left: 0, color: t.accent }}>—</span> {m}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {fb.fluency && (
                      <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.amber}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
                        <div style={{ ...eyebrow, marginBottom: 8 }}>HOW YOU SOUNDED</div>
                        <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>{fb.fluency}</p>
                      </div>
                    )}

                    {fb.grammar?.length > 0 && (
                      <div style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
                        <div style={{ ...eyebrow, marginBottom: 10 }}>SMALL FIXES</div>
                        {fb.grammar.map((g, i) => (
                          <div key={i} style={{ marginBottom: i === fb.grammar.length - 1 ? 0 : 12, fontSize: 14.5, lineHeight: 1.55 }}>
                            <div style={{ color: t.muted, textDecoration: "line-through" }}>{g.original}</div>
                            <div style={{ color: t.accent, fontWeight: 700 }}>{g.corrected}</div>
                            <div style={{ color: t.muted, marginTop: 4 }}>{g.why}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {fb.nextTime && (
                      <div style={{ borderLeft: `2px solid ${t.amber}`, paddingLeft: 16 }}>
                        <div style={{ ...eyebrow, marginBottom: 6 }}>NEXT TIME</div>
                        <p style={{ fontSize: 15.5, lineHeight: 1.6, margin: 0 }}>{fb.nextTime}</p>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <button className="tap" onClick={save} style={{ ...primary, flex: 1, padding: 15, fontSize: 15.5 }}>Save entry</button>
                  <button className="tap" onClick={spin} style={{ ...ghost, padding: "15px 20px", fontSize: 14.5, display: "flex", alignItems: "center", gap: 7 }}>
                    <RotateCcw size={15} /> Another
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------- ENTRIES ---------------- */}
      {showHistory && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(8,12,16,.6)", display: "flex", justifyContent: "flex-end", zIndex: 60 }}
          onClick={() => setShowHistory(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(380px,90vw)", height: "100%", background: t.flat, padding: 22, overflowY: "auto" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <div className="disp" style={{ fontSize: 21, fontWeight: 600 }}>Your entries</div>
              <button
                className="tap"
                onClick={() => setShowHistory(false)}
                aria-label="Close"
                style={{ ...ghost, minHeight: 40, borderRadius: 999, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <X size={16} />
              </button>
            </div>

            {history.length === 0 && (
              <p style={{ fontSize: 15, color: t.muted, lineHeight: 1.6 }}>
                Nothing saved yet. Draw a discovery and record your first entry.
              </p>
            )}

            {history.map((h, i) => (
              <div key={i} style={{ background: t.surface, border: `1px solid ${t.line}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>{h.topic.title}</div>
                <div style={{ fontSize: 12.5, color: t.muted, marginTop: 4 }}>{h.when} · {MODES[h.mode].label}</div>
                {h.audioURL && <audio controls src={h.audioURL} style={{ width: "100%", marginTop: 10, height: 36 }} />}
                {h.s && (
                  <div style={{ fontSize: 13.5, color: t.muted, marginTop: 8 }}>
                    {h.s.words} words · {h.s.wpm} per min · {h.s.fillers} fillers
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
