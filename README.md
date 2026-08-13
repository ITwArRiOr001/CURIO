# CURIO
Curio is a curiosity-driven learning and speaking platform. Discover obscure topics, research them independently, compare your findings with curated insights, then explain them aloud to improve communication, critical thinking, confidence, and lifelong learning.

A discovery and speaking-practice app.

Draw a term you've probably never heard of, read a short briefing, then explain it
out loud in your own words. The app records you, transcribes what you said, and
tells you whether you actually explained it well — not just whether your grammar
was correct.

The loop is deliberately small:

> Draw a topic → Read the hook → Research if needed → Speak → Get feedback → Save → Draw another

---

## Requirements

- Node.js 18 or newer
- npm 9 or newer

## Getting started

```bash
npm install
npm run dev
```

The dev server starts on <http://localhost:5173> and opens automatically.

## Scripts

| Command           | What it does                                        |
| ----------------- | --------------------------------------------------- |
| `npm run dev`     | Start the dev server with hot reload                 |
| `npm run build`   | Produce a production build in `dist/`                |
| `npm run preview` | Serve the built `dist/` locally on port 4173         |
| `npm run lint`    | Run ESLint (requires an `eslint.config.js` — see below) |

> `npm run lint` is wired up and the ESLint packages are installed, but no
> `eslint.config.js` ships with this project. Add one when you want linting,
> or remove the script. Everything else works without it.

## Project structure

```
unprompted/
├── index.html              Vite entry document, mounts #root
├── package.json
├── vite.config.js          React plugin, JSON handling, build chunking
├── render.yaml             Render.com static site deployment
├── .gitignore
├── README.md
└── src/
    ├── main.jsx            React root, imports index.css
    ├── App.jsx             Error boundary, renders Unprompted
    ├── index.css           Reset and document defaults only
    ├── Unprompted.jsx      The entire app
    └── data/
        └── topics.json     All content — the single source of truth
```

## Content

`src/data/topics.json` is the only place topics live. There is no topic data in
any component. It currently holds **216 topics across 10 categories**.

Each entry looks like this:

```json
{
  "id": "HI001",
  "cat": "HISTORY",
  "title": "The Year Without Summer",
  "hook": "In 1816, snow fell in June across New England. The cause was a volcano on the other side of the world.",
  "enriched": true,
  "summary": "...",
  "facts": ["...", "...", "..."],
  "vocab": [{ "word": "...", "meaning": "..." }],
  "question": "..."
}
```

`id`, `cat`, `title`, `hook` and `enriched` are required on every entry.

When `enriched` is `true`, the entry also carries `summary`, exactly three
`facts`, exactly three `vocab` items, and a `question` — these are shown as the
briefing. When `enriched` is `false`, the app generates that briefing on demand
and caches it for the session. **104 of the 216 topics are currently enriched.**

To add topics, append to the `topics` array. Keep `id` unique. No code changes
are needed — the app reads whatever is in the file.

### The content standard

The hook is the most important line in any entry. It must create emotion
*before* information — the opening of a documentary, not a sentence from an
encyclopedia. A reader should think *"wait, really?"* before they learn the
fact. Titles are two to five words, like a museum label. Everything stays
appropriate for under-18s.

## Deployment

### Render

`render.yaml` is included and ready. Push to a Git repository, then in Render
choose **New → Blueprint** and point it at the repo. It builds with `npm ci &&
npm run build` and publishes `dist/`.

The config also sets a rewrite so client-side routing works, long cache headers
on hashed assets, `no-cache` on `index.html` so users never get a stale build,
and a `Permissions-Policy` that allows the microphone and denies camera and
geolocation.

### Anywhere else

Any static host works. Build with `npm run build` and serve `dist/`. The only
requirement is a rewrite rule sending unmatched routes to `index.html`.

## Before you go live: the AI calls need a backend

**This matters.** `Unprompted.jsx` calls `https://api.anthropic.com/v1/messages`
directly from the browser for two features: generating a briefing for
non-enriched topics, and giving feedback on a recording. That works in a
sandboxed preview environment, but it **will not work on a deployed site** —
the browser will block it with a CORS error, and there is no API key attached
to the request.

Everything else — drawing topics, the reel, the briefing for enriched topics,
recording, transcription, playback, download, saved entries — works fully
without any backend.

To enable the AI features in production, add a small server route that holds
your API key and forwards the request, then point the app's `askClaude` helper
at your own endpoint instead of Anthropic's. Never put an API key in frontend
code or in a `VITE_`-prefixed environment variable: Vite inlines those into the
bundle, and anyone can read them.

On Render this means adding a Web Service alongside the static site, with the
key stored as an environment variable there.

## Browser support

- **Recording** uses `MediaRecorder`, supported in all current browsers. It
  requires HTTPS in production — `localhost` is exempt.
- **Live transcription** uses the Web Speech API, which is available in
  Chrome, Edge and Safari but not Firefox. Where it is unavailable, recording
  and playback still work; only the transcript and the feedback that depends on
  it are unavailable.
- **Audio cues** use the Web Audio API and fail silently if it is blocked.

## Accessibility notes

The app ships with a light and a dark theme, uses Atkinson Hyperlegible — a
typeface designed for low-vision readers — for all interface text, keeps every
tap target at least 48px, pairs teal and amber accents that stay distinguishable
under all common forms of colour blindness, and honours
`prefers-reduced-motion` by disabling the reel and transition animations.

## Known limitations

- **Saved entries are held in memory only.** Refreshing the page clears them,
  and recordings are object URLs that do not survive a reload. Persisting them
  needs storage and, for the parent/teacher review flow, accounts.
- 112 of the 216 topics rely on generated briefings, which means those depend
  on the backend described above.
  
