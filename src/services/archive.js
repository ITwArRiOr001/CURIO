/* ============================================================
   archive — the product. Entries survive reload.

   IndexedDB, not localStorage: audio blobs exceed the 5 MB
   localStorage quota within a handful of sessions.

   Device-local at V1. Export is the durability guarantee.
   ============================================================ */

const DB_NAME = "curio";
const DB_VERSION = 1;
const STORE = "entries";

const RETURN_AFTER_DAYS = 28;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("topic_id", "topic_id", { unique: false });
        store.createIndex("created_at", "created_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

/**
 * Writes one session. Stores BOTH the prediction and the explanation —
 * the prediction is the before-state and cannot be reconstructed later.
 */
export async function saveEntry(entry) {
  const record = {
    topic_id: entry.topic_id,
    topic_title: entry.topic_title,
    generation: entry.generation ?? 1,
    version: entry.version ?? 1,
    attempt_number: entry.attempt_number ?? 1,
    created_at: new Date().toISOString(),
    mode: entry.mode,
    elapsed_minutes: entry.elapsed_minutes ?? 0,
    revealed_early: Boolean(entry.revealed_early),
    prediction: {
      blob: entry.prediction?.blob ?? null,
      transcript: entry.prediction?.transcript ?? "",
    },
    explanation: {
      blob: entry.explanation?.blob ?? null,
      transcript: entry.explanation?.transcript ?? "",
    },
    feedback: entry.feedback ?? null,
  };
  await tx("readwrite", (s) => s.add(record));
  return record;
}

export async function listEntries() {
  const all = await tx("readonly", (s) => s.getAll());
  return (all ?? []).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function deleteEntry(id) {
  await tx("readwrite", (s) => s.delete(id));
}

export async function attemptCountFor(topicId) {
  const all = await listEntries();
  return all.filter((e) => e.topic_id === topicId).length;
}

/**
 * Return mechanic: topics first met at least RETURN_AFTER_DAYS ago
 * and not revisited since. Surfaced inside the normal flow — never
 * as a queue, a badge, or anything overdue.
 */
export async function getDueReturns() {
  const all = await listEntries();
  const cutoff = Date.now() - RETURN_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const byTopic = new Map();

  for (const e of all) {
    const cur = byTopic.get(e.topic_id) ?? { attempts: 0, latest: 0, title: e.topic_title };
    cur.attempts += 1;
    cur.latest = Math.max(cur.latest, new Date(e.created_at).getTime());
    byTopic.set(e.topic_id, cur);
  }

  return [...byTopic.entries()]
    .filter(([, v]) => v.latest <= cutoff)
    .map(([topic_id, v]) => ({ topic_id, title: v.title, attempts: v.attempts }));
}

/** Previous attempt on a topic — revealed only AFTER a new explanation exists. */
export async function previousAttempt(topicId) {
  const all = await listEntries();
  const prior = all.filter((e) => e.topic_id === topicId);
  return prior.length ? prior[prior.length - 1] : null;
}

/**
 * Export: dated transcripts as readable JSON plus every audio file.
 * The promise of permanence is not credible without this.
 */
export async function exportArchive() {
  const all = await listEntries();

  const readable = all.map((e) => ({
    date: e.created_at,
    topic: e.topic_title,
    topic_id: e.topic_id,
    attempt: e.attempt_number,
    mode: e.mode,
    minutes: e.elapsed_minutes,
    prediction: e.prediction.transcript,
    explanation: e.explanation.transcript,
  }));

  const manifestBlob = new Blob([JSON.stringify(readable, null, 2)], {
    type: "application/json",
  });

  return {
    manifest: manifestBlob,
    audio: all.flatMap((e) => {
      const stamp = e.created_at.slice(0, 10);
      const slug = (e.topic_title || "topic").replace(/[^\w]+/g, "-").toLowerCase();
      const files = [];
      if (e.prediction.blob) files.push({ name: `${stamp}_${slug}_prediction.webm`, blob: e.prediction.blob });
      if (e.explanation.blob) files.push({ name: `${stamp}_${slug}_explanation.webm`, blob: e.explanation.blob });
      return files;
    }),
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
