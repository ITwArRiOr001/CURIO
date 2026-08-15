/* ============================================================
   topicLoader — the only module that knows where topics live.
   Catalogue is bundled (small). Shards load lazily on demand.
   Adding shard files requires no change to this file.
   ============================================================ */

import catalogue from "../data/indexes/catalogue.json";
import manifest from "../data/manifest.json";

// Vite resolves this at build time; every file matching the glob becomes
// a lazy-loaded chunk. New shard files are picked up automatically.
const shardLoaders = import.meta.glob("../data/topics/*.json");

const SHARD_SIZE = manifest.shardSize;
const shardCache = new Map();

/** "C000042" -> 42 */
function idToNumber(id) {
  return parseInt(id.slice(1), 10);
}

/** 42 -> "000001-000100.json" (1-based ranges, matching the ID space) */
export function shardFileForId(id) {
  const n = idToNumber(id);
  const lo = Math.floor((n - 1) / SHARD_SIZE) * SHARD_SIZE + 1;
  const hi = lo + SHARD_SIZE - 1;
  return `${String(lo).padStart(6, "0")}-${String(hi).padStart(6, "0")}.json`;
}

async function loadShard(fileName) {
  if (shardCache.has(fileName)) return shardCache.get(fileName);

  const key = `../data/topics/${fileName}`;
  const loader = shardLoaders[key];
  if (!loader) throw new Error(`Shard not found: ${fileName}`);

  const mod = await loader();
  const data = mod.default ?? mod;
  shardCache.set(fileName, data);
  return data;
}

/** Thin index: id, title, family, shard. Safe to hold entirely in memory. */
export function getCatalogue() {
  return catalogue.topics;
}

export function getTotals() {
  return manifest.totals;
}

/** Full topic body. Loads its shard on first access, then caches. */
export async function loadTopic(id) {
  const entry = catalogue.topics.find((t) => t.id === id);
  const fileName = entry?.shard ?? shardFileForId(id);
  const shard = await loadShard(fileName);
  const topic = shard.topics.find((t) => t.id === id);
  if (!topic) throw new Error(`Topic ${id} missing from ${fileName}`);
  return topic;
}

/** Random selection, optionally excluding ids already seen this session. */
export function pickRandomId(excludeIds = []) {
  const pool = catalogue.topics.filter((t) => !excludeIds.includes(t.id));
  const source = pool.length > 0 ? pool : catalogue.topics;
  return source[Math.floor(Math.random() * source.length)].id;
}

/** Titles only — used to populate the draw reel without loading shards. */
export function reelTitles(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = catalogue.topics[Math.floor(Math.random() * catalogue.topics.length)];
    out.push({ id: t.id, title: t.title });
  }
  return out;
}
