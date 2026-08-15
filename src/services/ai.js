/* ============================================================
   ai — optional. Every one of the 104 launch topics ships with a
   hand-written briefing, so the full loop runs with no endpoint
   configured. Only feedback degrades.

   Set VITE_AI_ENDPOINT to your own proxy. Never put an API key
   in a VITE_ variable — Vite inlines it into the bundle.
   ============================================================ */

const ENDPOINT = import.meta.env.VITE_AI_ENDPOINT || "";
const PROMPT_VERSION = "feedback-v1";

export function aiAvailable() {
  return Boolean(ENDPOINT);
}

async function ask(prompt, maxTokens = 1200) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
  const data = await res.json();
  const text = (data.content ?? data.text ?? "")
    .toString()
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(text);
}

/**
 * Feedback answers the question that matters: did they explain it?
 * Model and prompt version travel with the result — without them,
 * a score from 2026 cannot be compared to one from 2030.
 */
export async function requestFeedback({ topic, predictionTranscript, explanationTranscript }) {
  if (!aiAvailable()) throw new Error("AI endpoint not configured");

  const prompt = `A learner explained a topic aloud. Judge warmly and specifically.

TOPIC: "${topic.title}"
WHAT IT IS ABOUT: "${topic.briefing}"
THE COMMON MISCONCEPTION: "${topic.misconception}"
THEIR FIRST GUESS: "${predictionTranscript || "(no guess recorded)"}"
THEIR EXPLANATION: "${explanationTranscript}"

Warm, plain language a 10-year-old could follow, detailed enough to teach.
Never harsh. Name a real strength first.

Respond with ONLY raw JSON, no fences:
{
  "encouragement": "2 warm sentences naming something genuinely done well",
  "understanding": {"verdict":"short phrase","detail":"2-3 sentences on whether they really explained it"},
  "escaped_misconception": true,
  "missed": ["a key point they did not mention"],
  "fluency": "2 sentences on flow, pace and confidence",
  "next_time": "one specific encouraging thing to try next session"
}
At most 2 items in "missed".`;

  const parsed = await ask(prompt);
  return {
    ...parsed,
    model_version: "server-configured",
    prompt_version: PROMPT_VERSION,
    generated_at: new Date().toISOString(),
  };
}
