"use strict";
/**
 * Fetches Google Books Ngram frequencies (English, 2010–2019, case-sensitive) for every answer name
 * and its longer aliases, into data/ngram-cache.json. Resumable: re-run to continue after a block.
 * Usage: node scripts/fetch-ngram.js
 * Then:  npm run build:freq -- --ngram data/ngram-cache.json
 */
const fs = require("node:fs"), path = require("node:path");
const E = require("../server/engine");
const bank = require("../server/questions");

const CACHE = path.join(__dirname, "../data/ngram-cache.json");
const BATCH = 12, DELAY_MS = 3000, MAX_FAILS = 8;   // 1.2 s per request drew a 403 after ~350 requests

const clean = s => s.replace(/\(.*?\)/g, " ").replace(/[,+*/[\]]/g, " ").replace(/\s+/g, " ").trim();
const title = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
/** The phrases looked up for an answer: its name as written, plus title-cased aliases of 4+ letters. */
const phrasesFor = e => [clean(e.name), ...e.aliases.filter(a => a.length >= 4).map(a => title(clean(a)))]
  .filter(p => p && p.split(" ").length <= 5);
/** Ngram echoes phrases re-tokenised ("Coca - Cola"), so match on a spacing-free key. */
const keyOf = s => s.replace(/\s+/g, "").toLowerCase();

if (require.main === module) main();

async function main() {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const todo = [...new Set(bank.flatMap(q => E.buildCatalog(q).entries.flatMap(phrasesFor)))].filter(p => !(p in cache));
  console.log(`${Object.keys(cache).length} cached, ${todo.length} to fetch (${Math.ceil(todo.length / BATCH)} requests)`);
  let fails = 0;
  for (let i = 0; i < todo.length;) {
    const batch = todo.slice(i, i + BATCH);
    const url = "https://books.google.com/ngrams/json?year_start=2010&year_end=2019&corpus=en&smoothing=0&content="
      + encodeURIComponent(batch.join(","));
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (research script)" } });
      if (r.status !== 200) throw new Error("HTTP " + r.status);
      const got = new Map((await r.json()).map(x => [keyOf(x.ngram), x.timeseries.reduce((a, b) => a + b, 0) / x.timeseries.length]));
      for (const p of batch) cache[p] = got.get(keyOf(p)) ?? 0;   // 0 = not found / below Ngram's threshold
      i += BATCH; fails = 0;
      if ((i / BATCH) % 25 === 0) { save(cache); console.log(`${Math.min(i, todo.length)}/${todo.length}`); }
      await sleep(DELAY_MS);
    } catch (err) {
      save(cache);
      if (++fails >= MAX_FAILS) { console.error(`stopping after ${fails} failures (${err.message}); re-run later to resume`); process.exit(1); }
      const wait = Math.min(15 * 60_000, 60_000 * 2 ** (fails - 1));   // 1, 2, 4, 8, then 15 min
      console.warn(`${err.message}; waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
  save(cache);
  console.log("done:", Object.keys(cache).length, "phrases");
}

function save(cache) { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { phrasesFor };
