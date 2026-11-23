"use strict";
/*
 * Soundings game engine — pure functions, no I/O.
 * Answer normalisation + matching, rarity tiers, scoring, depth, question picking per topic/mode.
 */

const ROUNDS = 7;
const QUESTION_MS = 25_000;
const GRACE_MS = 750;            // network latency allowance after the visible deadline
const METRES_PER_POINT = 10;
const EPOCH_UTC = Date.UTC(2026, 0, 1);  // Dive #1 = 2026-01-01; days roll over at 00:00 UTC
const PRIOR_N = 200;             // seed estimates count as this many virtual players
const SEED_TOP = 30;             // weight scale for position-based seed estimates (rank 1 ≈ 30)

// Rarity tiers, most common first. `minShare` = lowest share of accepted answers for the tier.
const TIERS = [
  { id: "drifter",   name: "Drifter",     points: 10,  minShare: 0.20,  creature: "jelly"  },
  { id: "scuttler",  name: "Scuttler",    points: 20,  minShare: 0.10,  creature: "crab"   },
  { id: "glimmer",   name: "Glimmer",     points: 35,  minShare: 0.05,  creature: "fish"   },
  { id: "lantern",   name: "Lantern",     points: 55,  minShare: 0.02,  creature: "angler" },
  { id: "leviathan", name: "Leviathan",   points: 80,  minShare: 0.005, creature: "manta"  },
  { id: "fallen",    name: "Fallen Star", points: 100, minShare: 0,     creature: "star"   },
];
const MAX_SCORE = ROUNDS * TIERS[TIERS.length - 1].points;

const ZONES = [
  { name: "Sunlight zone", from: 0 },
  { name: "Twilight zone", from: 200 },
  { name: "Midnight zone", from: 1000 },
  { name: "Abyssal zone",  from: 4000 },
  { name: "Hadal zone",    from: 6000 },
];

const ARTICLES = new Set(["the", "a", "an"]);

function singular(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ses|xes|ches|shes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Canonical comparison key: case/accent/punctuation/article/plural-insensitive, spaces removed. */
function normalize(input, strip = []) {
  const stripSet = new Set(strip);
  const words = String(input)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(" ").filter(Boolean);
  // a leading article is dropped only when something follows it ("A" alone is a valid answer: vitamin A)
  const kept = words.filter((w, i) => !stripSet.has(w) && !(i === 0 && words.length > 1 && ARTICLES.has(w)));
  // "Henry 5" == "Henry V", "Toy Story 2" == "Toy Story II": small numbers become Roman numerals
  return kept.map(w => (/^\d+$/.test(w) && +w >= 1 && +w <= 20 ? ROMAN[+w] : singular(w))).join("");
}
const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];

const slug = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Print frequency (Zipf scale) per answer, built by scripts/build-freq.js from Google Books Ngram
// (124 questions) and wordfreq (the rest; CC BY-SA 4.0).
let FREQ = null;
function freqTable() {
  if (!FREQ) { try { FREQ = require("./bank/_freq.json"); } catch { FREQ = {}; } }
  return FREQ;
}
// Blend between 0 (author order only) and 1 (print frequency only). Print alone misfires badly
// (tested 2026-11-23: 8,300 of 19,100 answers became Fallen Star), so it only nudges the author order:
// with FREQ_TRUST 5, about 22% of answers move one tier and 9 move two.
const FREQ_BLEND = 0.5;
const FREQ_CLAMP = 3;    // print frequency may move a prior at most 3× from the author's estimate
// Context misfires: print counts are fame in all books, not recall for this question ("France" for
// Brazil's borders, "Pawn" for chess pieces). When print and the question's own order disagree by
// more than this factor, print is talking about something else, so it is ignored for that answer.
const FREQ_TRUST = 5;

/**
 * Krillion-style prior: how often each answer appears in print, blended geometrically with the
 * author weight. Print counts are scaled so the question's typical (median) answer keeps its author
 * weight, so one huge outlier cannot shrink everything else; answers whose print rating is more
 * than FREQ_TRUST× off the author's are treated as context misfires and keep the author weight;
 * the rest move at most FREQ_CLAMP×. Entries without a frequency keep the author weight.
 * Returns the ids treated as misfires.
 */
function applyPrintFrequency(qid, entries, blend = FREQ_BLEND, table = freqTable()) {
  const z = blend > 0 && table[qid];
  if (!z) return [];
  const has = entries.filter(e => typeof z[e.id] === "number");
  if (has.length < 3) return [];
  // log10 of (print / author) per answer; centring on the median makes the typical answer neutral
  const logRatio = e => z[e.id] - Math.log10(e.authorWeight);
  const sorted = has.map(logRatio).sort((a, b) => a - b), mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const misfires = [];
  for (const e of has) {
    const off = logRatio(e) - median;   // log10 of how far print disagrees with the author
    if (Math.abs(off) > Math.log10(FREQ_TRUST)) { misfires.push(e.id); continue; }
    const w = e.authorWeight * 10 ** (blend * off);
    e.weight = Math.min(e.authorWeight * FREQ_CLAMP, Math.max(e.authorWeight / FREQ_CLAMP, w));
  }
  return misfires;
}

/** Parse a question's answer string into a catalog with a key→entry index. Throws on collisions. */
function buildCatalog(q) {
  const entries = [], index = new Map();
  const raws = q.answers.split(";").map(s => s.trim()).filter(Boolean);
  for (const [rank, raw] of raws.entries()) {
    // optional ":weight" suffix; titles may contain colons ("The Lost World: Jurassic Park")
    const wm = /:\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
    const names = wm ? raw.slice(0, wm.index) : raw;
    const [name, ...aliases] = names.split("|").map(s => s.trim());
    // no explicit weight: graded seed estimate from list position (lists run most-common first),
    // so rarity climbs gradually down the list instead of every unlisted answer being a Fallen Star
    const authorWeight = wm ? Number(wm[1]) : SEED_TOP / (rank + 1);
    const entry = { id: slug(name), name, aliases, authorWeight, weight: authorWeight, keys: [] };
    if (!(entry.weight > 0)) throw new Error(`${q.id}: bad weight in "${raw}"`);
    if (entries.some(e => e.id === entry.id)) throw new Error(`${q.id}: duplicate answer "${name}"`);
    for (const n of [name, ...aliases]) {
      const k = normalize(n, q.strip);
      if (!k) throw new Error(`${q.id}: alias "${n}" normalises to nothing`);
      const prev = index.get(k);
      if (prev && prev !== entry) throw new Error(`${q.id}: "${n}" collides with "${prev.name}"`);
      index.set(k, entry); entry.keys.push(k);
    }
    entries.push(entry);
  }
  applyPrintFrequency(q.id, entries);
  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  return { entries, index, totalWeight, byId: new Map(entries.map(e => [e.id, e])) };
}

/** Optimal string alignment distance (Levenshtein + adjacent transposition), capped. */
function distance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v; rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

const typoAllowance = len => (len >= 9 ? 2 : len >= 5 ? 1 : 0);

/**
 * Match a typed answer against a question catalog.
 * Exact key match wins; otherwise a unique closest key within the typo allowance.
 * Ambiguous fuzzy matches (two different answers equally close) are rejected.
 */
function match(q, catalog, input) {
  const key = normalize(input, q.strip);
  if (!key) return { ok: false, key, reason: "empty" };
  const exact = catalog.index.get(key);
  if (exact) return { ok: true, key, entry: exact, fuzzy: false };
  const cap = typoAllowance(key.length);
  if (!cap) return { ok: false, key, reason: "unknown" };
  let best = cap + 1, hits = new Set();
  for (const [k, entry] of catalog.index) {
    if (typoAllowance(k.length) === 0) continue;          // never fuzz onto very short answers
    const allow = Math.min(cap, typoAllowance(k.length));
    const dist = distance(key, k, allow);
    if (dist > allow) continue;
    if (dist < best) { best = dist; hits = new Set([entry]); }
    else if (dist === best) hits.add(entry);
  }
  if (best <= cap && hits.size === 1) return { ok: true, key, entry: [...hits][0], fuzzy: true };
  return { ok: false, key, reason: hits.size > 1 && best <= cap ? "ambiguous" : "unknown" };
}

/**
 * Share of accepted answers that are this entry: seed estimate (PRIOR_N virtual players)
 * blended with live recorded counts. counts: Map/obj entryId -> n (live, real submissions).
 */
function shareOf(catalog, entryId, counts) {
  const get = id => (counts instanceof Map ? counts.get(id) : counts[id]) || 0;
  let live = 0; for (const e of catalog.entries) live += get(e.id);
  const e = catalog.byId.get(entryId);
  const prior = (e.weight / catalog.totalWeight) * PRIOR_N;
  return { share: (prior + get(entryId)) / (PRIOR_N + live), liveTotal: live, liveForAnswer: get(entryId) };
}

function tierForShare(share) {
  return TIERS.find(t => share >= t.minShare) || TIERS[TIERS.length - 1];
}

function topAnswers(catalog, counts, n = 3) {
  return catalog.entries
    .map(e => ({ name: e.name, share: shareOf(catalog, e.id, counts).share }))
    .sort((a, b) => b.share - a.share).slice(0, n);
}

function dayIndex(ms = Date.now()) { return Math.floor((ms - EPOCH_UTC) / 86_400_000); }
function dayStartMs(day) { return EPOCH_UTC + day * 86_400_000; }

function rng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const DIFFICULTY = { easy: 0, medium: 1, hard: 2 };

/**
 * Choose questions for a dive. Pure: randomness comes from `random` (a () => [0,1) function).
 *  mode     quick | special | mixed | endless
 *  topic    topic id (quick/special required; endless optional; mixed ignored)
 *  count    how many to pick
 *  asked    Set of ids already used in this dive (never repeated)
 *  recent   Map id -> how many questions ago this player last saw it (0 = just now);
 *           unseen questions come first, then the ones seen longest ago
 *  avoidTopic  for mixed/endless fallback: don't open with the topic just played
 * Topic Special returns the chosen questions sorted easy → hard and aims for a 2/3/2 spread.
 */
function pickQuestions({ bank, mode, topic = null, count, asked = new Set(), recent = new Map(), random = Math.random, avoidTopic = null }) {
  const fresh = q => !recent.has(q.id);
  const order = list => {
    const a = list.map(q => ({ q, r: random() }));
    // unseen first (random among themselves), then least-recently seen first
    a.sort((x, y) => (fresh(y.q) - fresh(x.q)) || ((recent.get(y.q.id) ?? 0) - (recent.get(x.q.id) ?? 0)) || (x.r - y.r));
    return a.map(x => x.q);
  };
  const open = bank.filter(q => !asked.has(q.id));
  let picked = [];
  if (mode === "mixed") {
    const used = new Set(avoidTopic ? [avoidTopic] : []);
    const sorted = order(open);
    for (const q of sorted) { if (picked.length >= count) break; if (!used.has(q.topic)) { picked.push(q); used.add(q.topic); } }
    for (const q of sorted) { if (picked.length >= count) break; if (!picked.includes(q)) picked.push(q); }
  } else if (mode === "endless") {
    const inTopic = topic ? order(open.filter(q => q.topic === topic)) : [];
    const rest = order(open.filter(q => q.topic !== topic && q.topic !== avoidTopic));
    const tail = order(open.filter(q => q.topic !== topic && q.topic === avoidTopic));
    picked = [...inTopic, ...rest, ...tail].slice(0, count);
  } else {
    const pool = order(open.filter(q => q.topic === topic));
    if (mode === "special") {
      const want = [[0, 2], [1, 3], [2, 2]];
      for (const [d, n] of want) picked.push(...pool.filter(q => DIFFICULTY[q.difficulty] === d).slice(0, n));
      for (const q of pool) { if (picked.length >= count) break; if (!picked.includes(q)) picked.push(q); }
      picked = picked.slice(0, count).sort((a, b) => DIFFICULTY[a.difficulty] - DIFFICULTY[b.difficulty]);
    } else picked = pool.slice(0, count);
  }
  return picked.map(q => q.id);
}

const depthFor = points => points * METRES_PER_POINT;
function zoneFor(depth) { let z = ZONES[0]; for (const x of ZONES) if (depth >= x.from) z = x; return z.name; }

module.exports = {
  ROUNDS, QUESTION_MS, GRACE_MS, METRES_PER_POINT, PRIOR_N, TIERS, MAX_SCORE, ZONES, DIFFICULTY,
  normalize, buildCatalog, applyPrintFrequency, distance, match, shareOf, tierForShare, topAnswers,
  dayIndex, dayStartMs, pickQuestions, depthFor, zoneFor, rng,
};
