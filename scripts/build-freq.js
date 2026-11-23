"use strict";
/**
 * Builds server/bank/_freq.json: a print-frequency (Zipf) score for every answer, the way
 * Krillion scores rarity, used by the engine as a starting prior before real players' answers.
 *
 * Sources, per question:
 *   Google Books Ngram (whole names, case-sensitive), fetched by scripts/fetch-ngram.js, used for
 *     questions whose every looked-up phrase is in the cache;
 *   wordfreq (Robyn Speer, doi.org/10.5281/zenodo.7199437, data CC BY-SA 4.0), single words only,
 *     for the rest. From https://raw.githubusercontent.com/rspeer/wordfreq/master/wordfreq/data/large_en.msgpack.gz
 * Usage: node scripts/build-freq.js <large_en.msgpack.gz> [--ngram data/ngram-cache.json]
 */
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const { decode } = require("@msgpack/msgpack");
const E = require("../server/engine");
const bank = require("../server/questions");
const { phrasesFor } = require("./fetch-ngram");

const args = process.argv.slice(2), ni = args.indexOf("--ngram");
const ngram = ni >= 0 ? JSON.parse(fs.readFileSync(args[ni + 1], "utf8")) : {};
const src = args.find((a, i) => i !== ni && i !== ni + 1);
if (!src) { console.error("usage: node scripts/build-freq.js <large_en.msgpack.gz> [--ngram <cache.json>]"); process.exit(1); }

// wordfreq "cB" format: [header, bin0, bin1, ...]; words in bin i have frequency 10^(-i/100)
const data = decode(zlib.gunzipSync(fs.readFileSync(src)));
if (data[0]?.format !== "cB") throw new Error("not a wordfreq cB file");
const zipfOf = new Map();
for (let i = 1; i < data.length; i++) for (const w of data[i]) zipfOf.set(w, 9 - (i - 1) / 100);
const FLOOR = 1;   // below wordfreq's lowest bin (Zipf 1.0 ≈ once per billion words)
const K = 1;       // each extra word makes a name ~10× rarer than its rarest word (wordfreq only)

const strip = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const tokens = name => name.replace(/\(.*?\)/g, " ").toLowerCase().replace(/[’`]/g, "'")
  .split(/[^\p{L}\p{N}']+/u).map(t => t.replace(/^'+|'+$/g, "")).filter(Boolean);
const wordZipf = t => Math.max(zipfOf.get(t) ?? FLOOR, zipfOf.get(strip(t)) ?? FLOOR,
  t.endsWith("'s") ? (zipfOf.get(t.slice(0, -2)) ?? FLOOR) : FLOOR);

/** wordfreq's phrase rule (1/f = Σ 1/f_i) plus K Zipf points off per extra word. */
function phraseZipf(name) {
  const ts = tokens(name);
  if (!ts.length) return FLOOR;
  const inv = ts.reduce((s, t) => s + 10 ** -(wordZipf(t) - 9), 0);
  return Math.max(FLOOR, 9 + Math.log10(1 / inv) - K * (ts.length - 1));
}
/** Each source scores an answer by its best-known form: the name or a longer alias ("Picasso"). */
const wordfreqZipf = e => Math.max(...[e.name, ...e.aliases.filter(a => a.length >= 4)].map(phraseZipf));
const ngramZipf = e => {
  const f = Math.max(0, ...phrasesFor(e).map(p => ngram[p] || 0));
  return f > 0 ? Math.max(FLOOR, 9 + Math.log10(f)) : FLOOR;
};

const out = {}, used = { ngram: 0, wordfreq: 0 };
for (const q of bank) {
  const c = E.buildCatalog(q);
  if (c.entries.length < 3) continue;
  const covered = c.entries.every(e => phrasesFor(e).every(p => p in ngram));
  used[covered ? "ngram" : "wordfreq"]++;
  out[q.id] = Object.fromEntries(c.entries.map(e => [e.id, +(covered ? ngramZipf : wordfreqZipf)(e).toFixed(2)]));
}
fs.writeFileSync(path.join(__dirname, "../server/bank/_freq.json"), JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length} questions (Ngram ${used.ngram}, wordfreq ${used.wordfreq})`);
