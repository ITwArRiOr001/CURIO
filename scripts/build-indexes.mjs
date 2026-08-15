/* Rebuilds every file under src/data/indexes/ and src/data/manifest.json
   from the authored shards. Never hand-edit the outputs. */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOPICS = join(root, "src/data/topics");
const INDEXES = join(root, "src/data/indexes");
const SHARD_SIZE = 100;

const FAMILIES = [
  { id: "we-were-confidently-wrong", name: "We Were Confidently Wrong",
    description: "Expert consensus that turned out to be mistaken, and how the correction arrived." },
  { id: "mind-deceiving-itself", name: "The Mind Deceiving Itself",
    description: "Perception, memory and judgment failing in ways introspection cannot detect." },
  { id: "everyday-word", name: "The Everyday Word",
    description: "Ordinary words and objects whose real origin nobody has looked up." },
  { id: "accidents-that-worked", name: "Accidents That Worked",
    description: "Mistakes, failures and stray observations that changed everyday life." },
  { id: "order-without-designer", name: "Order Without a Designer",
    description: "Patterns that look deliberate and are produced by nothing that intended them." },
  { id: "measurement-changes-the-thing", name: "Measurement Changes the Thing",
    description: "Cases where observing a system alters what the system does." },
  { id: "small-cause-vast-effect", name: "Small Cause, Vast Effect",
    description: "Minor events whose consequences scaled far beyond anyone's expectation." },
  { id: "boundaries-that-dissolve", name: "Boundaries That Dissolve",
    description: "Categories treated as sharp that turn out to be gradients." },
  { id: "what-survived", name: "What Survived and What Didn't",
    description: "Knowledge that was lost, preserved or never decoded — and why." },
  { id: "systems-nobody-designed", name: "Systems Nobody Designed",
    description: "Incentives and institutions producing outcomes no one chose." },
  { id: "hidden-machinery", name: "The Hidden Machinery of Bodies",
    description: "Living systems working in ways stranger than their owners assume." },
  { id: "things-we-still-dont-know", name: "Things We Still Don't Know",
    description: "Open questions where not knowing is the honest scientific state." },
];

const shardFiles = readdirSync(TOPICS).filter((f) => /^\d{6}-\d{6}\.json$/.test(f)).sort();

const topics = [];
const shards = [];

for (const file of shardFiles) {
  const raw = readFileSync(join(TOPICS, file), "utf8");
  const data = JSON.parse(raw);
  shards.push({
    file: `topics/${file}`,
    idRange: data.idRange,
    count: data.topics.length,
    sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  });
  topics.push(...data.topics.map((t) => ({ ...t, __shard: file })));
}

topics.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

const catalogue = {
  generated: true,
  source: "src/data/topics/*.json",
  count: topics.length,
  topics: topics.map((t) => ({
    id: t.id, title: t.title, family: t.family, shard: t.__shard,
  })),
};
writeFileSync(join(INDEXES, "catalogue.json"), JSON.stringify(catalogue, null, 1) + "\n");

const byFamily = {
  generated: true,
  source: "src/data/topics/*.json",
  familyCount: FAMILIES.length,
  families: FAMILIES.map((f) => {
    const ids = topics.filter((t) => t.family === f.id).map((t) => t.id);
    return { id: f.id, name: f.name, description: f.description, count: ids.length, topic_ids: ids };
  }),
};
writeFileSync(join(INDEXES, "by-family.json"), JSON.stringify(byFamily, null, 1) + "\n");

const queue = JSON.parse(readFileSync(join(root, "src/data/queue/pending-authoring.json"), "utf8"));
const retired = JSON.parse(readFileSync(join(root, "src/data/retired/retired.json"), "utf8"));

const manifest = {
  schemaVersion: 2,
  shardSize: SHARD_SIZE,
  idPrefix: "C",
  shards,
  totals: { live: topics.length, queued: queue.count ?? queue.topics.length, retired: retired.retired.length },
};
writeFileSync(join(root, "src/data/manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

console.log(`indexes rebuilt — ${topics.length} topics, ${shards.length} shards, ${FAMILIES.length} families`);
