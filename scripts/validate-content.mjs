/* Validates internal consistency across:
     manifest.json · topic shards · topic.schema.json
     indexes/catalogue.json · indexes/by-family.json

   Exit code 1 on any error. Wire into the build before deploy. */

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const P = (p) => join(root, "src/data", p);
const read = (p) => JSON.parse(readFileSync(P(p), "utf8"));

const errors = [];
const rules = [];
const fail = (rule, detail) => errors.push(`${rule}: ${detail}`);
const rule = (name, ok) => { rules.push({ name, ok }); if (!ok) fail(name, "failed"); };

const schema = read("schemas/topic.schema.json");
const manifest = read("manifest.json");
const catalogue = read("indexes/catalogue.json");
const byFamily = read("indexes/by-family.json");
const queue = read("queue/pending-authoring.json");
const retired = read("retired/retired.json");

const topicDef = schema.definitions.topic;
const rmDef = schema.definitions.referenceMaterial;

/* ---- load shards ---- */
const shardFiles = readdirSync(P("topics")).filter((f) => /^\d{6}-\d{6}\.json$/.test(f)).sort();
const shards = shardFiles.map((f) => {
  const raw = readFileSync(join(P("topics"), f), "utf8");
  return { file: f, raw, data: JSON.parse(raw) };
});
const topics = shards.flatMap((s) => s.data.topics);

/* ---- 1. shard envelope ---- */
for (const s of shards) {
  if (s.data.shard !== s.file) fail("shard-self-name", `${s.file} declares ${s.data.shard}`);
  if (s.data.count !== s.data.topics.length) fail("shard-count", `${s.file} count mismatch`);
  if (s.data.topics.length > schema.properties.count.maximum)
    fail("shard-capacity", `${s.file} exceeds ${schema.properties.count.maximum}`);
}
rule("shard envelope consistent", !errors.length);

/* ---- 2. id integrity ---- */
const ids = topics.map((t) => t.id);
rule("ids unique", new Set(ids).size === ids.length);
rule("ids match pattern", ids.every((i) => /^C\d{6}$/.test(i)));

const before = errors.length;
for (const s of shards) {
  const lo = Number(s.data.idRange[0].slice(1));
  const hi = Number(s.data.idRange[1].slice(1));
  for (const t of s.data.topics) {
    const n = Number(t.id.slice(1));
    if (n < lo || n > hi) fail("id-in-range", `${t.id} outside ${s.file}`);
  }
}
rule("every id inside its shard range", errors.length === before);

/* ---- 3. schema conformance ---- */
const b3 = errors.length;
const allowed = new Set(Object.keys(topicDef.properties));
for (const t of topics) {
  for (const f of topicDef.required) {
    if (t[f] === undefined || t[f] === null || t[f] === "") fail("required-field", `${t.id} missing ${f}`);
  }
  for (const k of Object.keys(t)) {
    if (!allowed.has(k)) fail("unknown-field", `${t.id} has ${k}`);
  }
  for (const [f, p] of Object.entries(topicDef.properties)) {
    const v = t[f];
    if (v === undefined) continue;
    if (p.type === "string") {
      if (p.minLength && v.length < p.minLength) fail("min-length", `${t.id}.${f} = ${v.length}`);
      if (p.maxLength && v.length > p.maxLength) fail("max-length", `${t.id}.${f} = ${v.length}`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) fail("pattern", `${t.id}.${f}`);
    }
    if (p.type === "integer" && (!Number.isInteger(v) || v < (p.minimum ?? -Infinity)))
      fail("integer", `${t.id}.${f}`);
    if (p.enum && !p.enum.includes(v)) fail("enum", `${t.id}.${f} = ${v}`);
  }
}
rule("topics conform to schema", errors.length === b3);

/* ---- 4. reference_material ---- */
const b4 = errors.length;
const threadPattern = new RegExp(rmDef.properties.research_threads.items.pattern);
for (const t of topics) {
  const rm = t.reference_material;
  for (const key of rmDef.required) {
    if (!Array.isArray(rm[key])) { fail("rm-shape", `${t.id}.${key}`); continue; }
    const p = rmDef.properties[key];
    if (rm[key].length < p.minItems || rm[key].length > p.maxItems)
      fail("rm-count", `${t.id}.${key} = ${rm[key].length}`);
  }
  for (const th of rm.research_threads ?? []) {
    if (!threadPattern.test(th)) fail("answer-leak", `${t.id}: "${th.slice(0, 50)}"`);
  }
}
rule("reference_material well formed", errors.length === b4);
rule("answer-leak guard clean", !errors.some((e) => e.startsWith("answer-leak")));

/* ---- 5. manifest ---- */
const b5 = errors.length;
if (manifest.shards.length !== shards.length) fail("manifest-shard-count", "mismatch");
for (const m of manifest.shards) {
  const s = shards.find((x) => `topics/${x.file}` === m.file);
  if (!s) { fail("manifest-shard-missing", m.file); continue; }
  if (s.data.topics.length !== m.count) fail("manifest-count", m.file);
  const sha = createHash("sha256").update(s.raw).digest("hex").slice(0, 16);
  if (sha !== m.sha256) fail("manifest-checksum", `${m.file} stale — rerun build-indexes`);
}
if (manifest.totals.live !== topics.length) fail("manifest-total-live", "mismatch");
if (manifest.totals.queued !== (queue.count ?? queue.topics.length)) fail("manifest-total-queued", "mismatch");
if (manifest.totals.retired !== retired.retired.length) fail("manifest-total-retired", "mismatch");
rule("manifest matches shards on disk", errors.length === b5);

/* ---- 6. catalogue ---- */
const b6 = errors.length;
if (catalogue.count !== topics.length) fail("catalogue-count", "mismatch");
const catIds = new Set(catalogue.topics.map((c) => c.id));
for (const t of topics) if (!catIds.has(t.id)) fail("catalogue-missing", t.id);
for (const c of catalogue.topics) {
  const t = topics.find((x) => x.id === c.id);
  if (!t) { fail("catalogue-orphan", c.id); continue; }
  if (t.title !== c.title) fail("catalogue-title", c.id);
  if (t.family !== c.family) fail("catalogue-family", c.id);
  if (!shardFiles.includes(c.shard)) fail("catalogue-shard-file", `${c.id} -> ${c.shard}`);
  const owner = shards.find((s) => s.file === c.shard);
  if (owner && !owner.data.topics.some((x) => x.id === c.id))
    fail("catalogue-shard-wrong", `${c.id} not in ${c.shard}`);
}
rule("catalogue resolves to real shards", errors.length === b6);

/* ---- 7. family index ---- */
const b7 = errors.length;
const declared = new Set(topicDef.properties.family.enum);
if (byFamily.families.length !== declared.size) fail("family-count", "index/schema mismatch");
const seen = new Set();
for (const f of byFamily.families) {
  if (!declared.has(f.id)) fail("family-unknown", f.id);
  if (!f.name || !f.description) fail("family-metadata", f.id);
  if (f.topic_ids.length !== f.count) fail("family-count-field", f.id);
  for (const id of f.topic_ids) {
    if (!catIds.has(id)) fail("family-orphan", `${f.id} -> ${id}`);
    if (seen.has(id)) fail("family-duplicate", id);
    seen.add(id);
    const t = topics.find((x) => x.id === id);
    if (t && t.family !== f.id) fail("family-mismatch", `${id}`);
  }
}
if (seen.size !== topics.length) fail("family-coverage", `${seen.size}/${topics.length} indexed`);
rule("family index complete and exclusive", errors.length === b7);

/* ---- 8. serving status ---- */
rule("all served topics are live", topics.every((t) => t.status === "live"));
rule("queue not served", !topics.some((t) => queue.topics.some((q) => q.title === t.title && q.class)));

/* ---- report ---- */
const families = byFamily.families.filter((f) => f.count > 0).length;
console.log("");
console.log("  CURIO CONTENT VALIDATION");
console.log("  " + "-".repeat(46));
console.log(`  total topics       ${topics.length}`);
console.log(`  shard files        ${shards.length}`);
console.log(`  families declared  ${byFamily.families.length}  (populated: ${families})`);
console.log(`  queued             ${manifest.totals.queued}`);
console.log(`  retired            ${manifest.totals.retired}`);
console.log("  " + "-".repeat(46));
for (const r of rules) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
console.log("  " + "-".repeat(46));

if (errors.length) {
  console.log(`  ${errors.length} ERROR(S)`);
  errors.slice(0, 25).forEach((e) => console.log(`    ${e}`));
  process.exit(1);
}
console.log("  ALL CHECKS PASSED\n");
