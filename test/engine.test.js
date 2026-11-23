"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../server/engine");
const bank = require("../server/questions");
const { TOPICS, MODES } = require("../server/topics");
const { openDb } = require("../server/db");
const { createGame, GameError } = require("../server/game");
const { createAuth, createLimiter, sha256 } = require("../server/auth");

const Q = id => bank.find(q => q.id === id);
const cat = id => E.buildCatalog(Q(id));
const m = (id, s) => { const r = E.match(Q(id), cat(id), s); return r.ok ? r.entry.name : r.reason; };

// ---------- question bank ----------
test("bank: every question is complete, catalogued and classified", () => {
  assert.equal(new Set(bank.map(q => q.id)).size, bank.length);
  for (const q of bank) {
    E.buildCatalog(q);
    assert.ok(TOPICS.some(t => t.id === q.topic), q.id + " topic");
    assert.ok(["easy", "medium", "hard"].includes(q.difficulty), q.id + " difficulty");
    assert.ok(q.explain && q.explain.length > 20, q.id + " explanation");
    assert.ok(q.hint, q.id + " hint");
  }
});

test("bank: every topic can fill a 7-question dive without repeats", () => {
  for (const t of TOPICS) {
    const n = bank.filter(q => q.topic === t.id).length;
    assert.ok(n >= 8, `${t.id} has only ${n} questions`);
    assert.ok(t.icon.length === 9 && t.icon.every(r => r.length === 9), t.id + " icon is 9x9");
  }
  assert.equal(TOPICS.length, 20);
});

// ---------- normalisation & matching ----------
test("normalisation: case, whitespace, accents, punctuation, articles, plurals", () => {
  assert.equal(m("oceans-seas", "  PACIFIC   OCEAN "), "Pacific");
  assert.equal(m("oceans-seas", "the pacific"), "Pacific");
  assert.equal(m("africa", "Côte d'Ivoire"), "Ivory Coast");
  assert.equal(m("shakespeare", "Romeo & Juliet"), "Romeo and Juliet");
  assert.equal(m("crustaceans", "crabs"), "Crab");
  assert.equal(m("sea-mammals", "sealion"), "Sea lion");
});

test("aliases, alternative spellings and numbers", () => {
  assert.equal(m("sea-mammals", "killer whale"), "Orca");
  assert.equal(m("elements", "aluminum"), "Aluminium");
  assert.equal(m("dinosaurs", "T. rex"), "Tyrannosaurus");
  assert.equal(m("shakespeare", "henry 5"), "Henry V");
  assert.equal(m("british-monarchs", "Elizabeth 2"), "Elizabeth II");
  assert.equal(m("star-wars-films", "Episode 5"), "The Empire Strikes Back");
  assert.equal(m("vitamins", "A"), "A");
  assert.equal(m("vitamins", "vitamin b12"), "B12");
  assert.equal(m("spielberg", "The Lost World: Jurassic Park"), "The Lost World: Jurassic Park");
});

test("small typos accepted, short words exact only, ambiguity rejected", () => {
  assert.equal(m("oceans-seas", "pacfic"), "Pacific");
  assert.equal(m("planets", "Jupitor"), "Jupiter");
  assert.equal(m("planets", "mar"), "unknown");
  assert.equal(m("africa", "Niger"), "Niger");
  assert.equal(m("british-monarchs", "Henry"), "ambiguous");
});

test("rejects invalid answers and answers made only of the question's words", () => {
  assert.equal(m("planets", "Pluto"), "unknown");
  assert.equal(m("planets", "planet"), "empty");
  assert.equal(m("oceans-seas", "the sea"), "empty");
  assert.ok(["unknown", "ambiguous"].includes(m("roman-emperors", "Julius Caesar")));
});

// ---------- rarity ----------
test("rarity: graded by answer share; live data moves it; not every unusual answer is 100", () => {
  const c = cat("planets"), tier = (id, counts = {}) => E.tierForShare(E.shareOf(c, id, counts).share).id;
  assert.equal(tier("mars"), "drifter");
  assert.ok(["glimmer", "lantern"].includes(tier("neptune")), "print frequency may nudge Neptune one tier rarer");
  assert.equal(tier("neptune", { neptune: 1000 }), "drifter");
  assert.deepEqual(E.TIERS.map(t => t.points), [10, 20, 35, 55, 80, 100]);
  // a long list without explicit weights climbs gradually rather than jumping to 100
  const cs = cat("minecraft-mobs"), tiers = cs.entries.map(e => E.tierForShare(E.shareOf(cs, e.id, {}).share).id);
  assert.ok(new Set(tiers).size >= 4, "graded tiers: " + [...new Set(tiers)]);
  assert.ok(tiers.filter(t => t === "fallen").length < tiers.length / 2);
});

test("print-frequency prior: nudges toward print fame within the clamp; context misfires are ignored", () => {
  const c = cat("planets");
  const fresh = () => c.entries.map(e => ({ ...e, weight: e.authorWeight }));
  // print agrees with the author order exactly, except Neptune (≈3× more famous) and Jupiter (100×: a misfire)
  const zipf = Object.fromEntries(c.entries.map(e => [e.id, Math.log10(e.authorWeight)]));
  zipf.neptune += 0.5; zipf.jupiter += 2;
  const entries = fresh(), misfires = E.applyPrintFrequency("planets", entries, 1, { planets: zipf });
  const w = id => entries.find(e => e.id === id);
  assert.ok(w("neptune").weight > w("neptune").authorWeight && w("neptune").weight <= w("neptune").authorWeight * 3 + 1e-9, "Neptune up, at most 3×");
  assert.equal(w("mars").weight, w("mars").authorWeight, "agreeing answers keep their weight");
  assert.deepEqual(misfires, ["jupiter"]);
  assert.equal(w("jupiter").weight, w("jupiter").authorWeight, "misfire keeps the author weight");
  const off = fresh(); E.applyPrintFrequency("planets", off, 0, { planets: zipf });
  assert.ok(off.every(e => e.weight === e.authorWeight), "blend 0 is off");
  const missing = fresh(); E.applyPrintFrequency("planets", missing, 1, {});
  assert.ok(missing.every(e => e.weight === e.authorWeight), "no data keeps the author weight");
});

// ---------- picker ----------
const seq = s => { let x = s; return () => (x = (x * 16807) % 2147483647) / 2147483647; };
test("picker: quick stays in topic, no repeats, prefers unseen questions", () => {
  const ids = E.pickQuestions({ bank, mode: "quick", topic: "space", count: 7, random: seq(3) });
  assert.equal(new Set(ids).size, 7);
  assert.ok(ids.every(id => Q(id).topic === "space"));
  const recent = new Map(ids.map((id, i) => [id, i]));
  const again = E.pickQuestions({ bank, mode: "quick", topic: "space", count: 7, recent, random: seq(9) });
  for (const id of again) assert.ok(!recent.has(id), "recent question repeated: " + id);
});

test("picker: mixed uses 7 different topics; special rises in difficulty; endless honours topic then spills over", () => {
  const mixed = E.pickQuestions({ bank, mode: "mixed", count: 7, random: seq(5) });
  assert.equal(new Set(mixed.map(id => Q(id).topic)).size, 7);
  const sp = E.pickQuestions({ bank, mode: "special", topic: "history", count: 7, random: seq(7) }).map(id => E.DIFFICULTY[Q(id).difficulty]);
  assert.deepEqual(sp, [...sp].sort((a, b) => a - b));
  const asked = new Set(bank.filter(q => q.topic === "music").map(q => q.id));
  const spill = E.pickQuestions({ bank, mode: "endless", topic: "music", count: 1, asked, random: seq(2) });
  assert.notEqual(Q(spill[0]).topic, "music");
});

// ---------- game service ----------
async function setup(t0 = Date.UTC(2026, 10, 20, 12)) {
  let t = t0;
  const db = await openDb(":memory:");
  const game = createGame({ db, bank, now: () => t, random: seq(11) });
  const mk = db.prepare("INSERT OR IGNORE INTO players (id, created_at) VALUES (?, 0)");
  const start = game.start;
  game.start = async (pid, o) => { await mk.run(pid); return start(pid, o); };
  return { game, db, tick: ms => { t += ms; } };
}
const commonFor = v => cat(bank.find(q => q.text === v.dive.log[v.dive.idx].text).id).entries[0].name;
const err = (p, code) => assert.rejects(p, e => e instanceof GameError && e.code === code);
async function play(game, pid, opts, how = "answer") {
  let v = await game.start(pid, opts);
  while (v.dive.phase !== "done") {
    v = how === "answer" ? await game.answer(pid, { dive: v.dive.id, seq: v.dive.seq, text: commonFor(v) }) : await game.pass(pid, { dive: v.dive.id, seq: v.dive.seq });
    v = await game.next(pid, { dive: v.dive.id, seq: v.dive.seq });
  }
  return v;
}

test("unlimited: finish a dive, start another immediately, again and again", async () => {
  const { game } = await setup();
  const ids = new Set();
  for (let i = 0; i < 4; i++) { const v = await play(game, "p", { mode: "quick", topic: i % 2 ? "space" : "movies" }); assert.equal(v.dive.phase, "done"); ids.add(v.dive.id); }
  assert.equal(ids.size, 4, "every dive has its own id");
  assert.equal((await game.state("p")).player.dives, 4);
});

test("a dive: reject, retry, accept, pass, timeout; score and depth from recorded rounds", async () => {
  const { game, tick } = await setup();
  let v = await game.start("p", { mode: "quick", topic: "geography" });
  v = await game.answer("p", { dive: v.dive.id, seq: v.dive.seq, text: "definitely not an answer" });
  assert.equal(v.result.outcome, "rejected");
  v = await game.answer("p", { dive: v.dive.id, seq: v.dive.seq, text: commonFor(v) });
  assert.equal(v.result.outcome, "accepted");
  await err(game.answer("p", { dive: v.dive.id, seq: v.dive.seq, text: "x" }), "closed");
  v = await game.next("p", { dive: v.dive.id, seq: v.dive.seq });
  v = await game.pass("p", { dive: v.dive.id, seq: v.dive.seq });
  v = await game.next("p", { dive: v.dive.id, seq: v.dive.seq });
  tick(MODES.quick.questionMs + E.GRACE_MS + 1);
  v = await game.state("p");
  assert.equal(v.dive.log[2].status, "timeout");
  assert.ok(v.dive.log[0].explain, "closed rounds carry the explanation");
  const sum = v.dive.log.reduce((s, r) => s + (r.points || 0), 0);
  assert.equal(v.dive.score, sum); assert.equal(v.dive.depth, sum * 10);
});

test("replays and other players' dives are refused", async () => {
  const { game } = await setup();
  let v = await game.start("p", { mode: "mixed" });
  const s0 = v.dive.seq;
  v = await game.answer("p", { dive: v.dive.id, seq: s0, text: commonFor(v) });
  await err(game.answer("p", { dive: v.dive.id, seq: s0, text: "again" }), "stale");
  await game.start("q", { mode: "mixed" });
  await err(game.next("q", { dive: v.dive.id, seq: v.dive.seq }), "no-dive");
  await err(game.review("q", v.dive.id), "no-dive");
});

test("starting a new dive abandons the unfinished one; abandoned dives stay out of stats", async () => {
  const { game } = await setup();
  const a = await game.start("p", { mode: "quick", topic: "art" });
  const b = await game.start("p", { mode: "quick", topic: "music" });
  await err(game.answer("p", { dive: a.dive.id, seq: a.dive.seq, text: "x" }), "stale");
  assert.equal((await game.state("p")).dive.id, b.dive.id);
  assert.equal((await game.history("p")).dives.length, 0);
  assert.equal((await game.state("p")).player.timedOut, 0);
});

test("no repeats within a dive and recently played questions are avoided", async () => {
  const { game } = await setup();
  const first = await play(game, "p", { mode: "quick", topic: "music" });
  const second = await play(game, "p", { mode: "quick", topic: "music" });
  for (const v of [first, second]) assert.equal(new Set(v.dive.log.map(r => r.text)).size, 7);
  for (const r of second.dive.log) assert.ok(!first.dive.log.some(f => f.text === r.text), "repeated from last dive: " + r.text);
});

test("topic special: escalating difficulty, 30 s timer, mastery rank", async () => {
  const { game } = await setup();
  const v = await play(game, "p", { mode: "special", topic: "dinosaurs" });
  const d = v.dive.log.map(r => E.DIFFICULTY[r.difficulty]);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.equal(v.dive.questionMs, 30000);
  assert.equal(v.dive.mastery, "Abyss master");
});

test("endless: three air tanks, passes cost one, surfacing keeps the score", async () => {
  const { game } = await setup();
  const out = await play(game, "p", { mode: "endless" }, "pass");
  assert.equal(out.dive.endReason, "out-of-air"); assert.equal(out.dive.log.length, 3);
  let v = await game.start("p", { mode: "endless", topic: "space" });
  const n = bank.filter(q => q.topic === "space").length;
  for (let i = 0; i < n + 2; i++) { v = await game.answer("p", { dive: v.dive.id, seq: v.dive.seq, text: commonFor(v) }); v = await game.next("p", { dive: v.dive.id, seq: v.dive.seq }); }
  assert.equal(v.dive.lives, 3); assert.equal(v.dive.log.length, n + 3);
  assert.ok(v.dive.log.slice(0, n).every(r => r.topic === "space"), "chosen topic first");
  assert.ok(v.dive.log.slice(n).every(r => r.topic !== "space"), "then other topics");
  const score = v.dive.score;
  v = await game.surface("p", { dive: v.dive.id, seq: v.dive.seq });
  assert.equal(v.dive.phase, "done"); assert.equal(v.dive.endReason, "surfaced"); assert.equal(v.dive.score, score);
  const quick = await play(game, "p", { mode: "quick", topic: "art" });
  await err(game.surface("p", { dive: quick.dive.id, seq: 99 }), "stale");
});

test("invalid modes and topics are refused", async () => {
  const { game } = await setup();
  await err(game.start("p", { mode: "daily" }), "bad-mode");
  await err(game.start("p", { mode: "quick" }), "bad-topic");
  await err(game.start("p", { mode: "special", topic: "nope" }), "bad-topic");
});

test("permanent stats, records, favourite topics, rarest answer, history and review", async () => {
  const { game } = await setup();
  await play(game, "p", { mode: "quick", topic: "space" });
  await play(game, "p", { mode: "quick", topic: "space" });
  await play(game, "p", { mode: "mixed" });
  await play(game, "p", { mode: "endless", topic: "art" }, "pass");
  const s = (await game.state("p")).player;
  assert.equal(s.dives, 4);
  assert.equal(s.questionsAnswered, 7 * 3 + 3);
  assert.equal(s.favoriteTopics[0].topic, "space");
  assert.ok(s.records.quick.bestScore > 0 && s.records.endless.longestRun === 3);
  assert.ok(s.rarest && s.rarest.answer && s.rarest.question);
  assert.equal(s.deepest, s.bestScore * 10);
  const h = (await game.history("p")).dives;
  assert.equal(h.length, 4);
  const r = await game.review("p", h[0].id);
  assert.equal(r.dive.id, h[0].id); assert.ok(r.dive.log.every(x => x.status !== "open"));
});

test("rarity snapshot is shared by everyone on the same question that day", async () => {
  const { game } = await setup();
  const qid = "planets";
  const shares = [];
  for (const p of ["a", "b", "c"]) {
    // the question may not come up in the first dive; new dives prefer unseen questions, so it soon does
    const at = v => bank.find(q => q.text === v.dive.log[v.dive.idx].text).id === qid;
    let v;
    for (let tries = 0; tries < 10 && !(v && at(v)); tries++) {
      v = await game.start(p, { mode: "quick", topic: "space" });
      while (!at(v) && v.dive.idx < 6) { v = await game.pass(p, { dive: v.dive.id, seq: v.dive.seq }); v = await game.next(p, { dive: v.dive.id, seq: v.dive.seq }); }
    }
    assert.ok(at(v), "question never came up");
    shares.push((await game.answer(p, { dive: v.dive.id, seq: v.dive.seq, text: "Mars" })).dive.log[v.dive.idx].share);
  }
  assert.equal(new Set(shares).size, 1);
});

test("legacy daily dives migrate into the history when the database is reopened", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snd-")), "legacy.db");
  const db = await openDb(file);
  await db.prepare("INSERT INTO players (id, created_at) VALUES ('old', 0)").run();
  await db.prepare("INSERT INTO sessions (day, player, phase, idx, seq, score, started_at, finished_at) VALUES (300, 'old', 'done', 6, 9, 120, 1, 2)").run();
  await db.prepare("INSERT INTO rounds (day, player, n, qid, started_at, deadline, status, points) VALUES (300, 'old', 0, 'planets', 1, 2, 'passed', 0)").run();
  db.close();
  const reopened = await openDb(file);                 // migration runs on open
  (await openDb(file)).close();                        // and is idempotent
  const game = createGame({ db: reopened, bank });
  const h = (await game.history("old")).dives;
  assert.equal(h.length, 1); assert.equal(h[0].modeName, "Daily Dive (legacy)"); assert.equal(h[0].score, 120); assert.equal(h[0].questions, 1);
  assert.equal((await game.review("old", h[0].id)).dive.log[0].status, "passed");
  reopened.close();
});

test("concurrent requests: parallel transactions queue instead of failing", async () => {
  const { game } = await setup();
  const starts = await Promise.all(["a", "b", "c", "d"].map(p => game.start(p, { mode: "quick", topic: "space" })));
  const answers = await Promise.all(starts.map((v, i) => game.answer("abcd"[i], { dive: v.dive.id, seq: v.dive.seq, text: commonFor(v) })));
  assert.ok(answers.every(v => v.result.outcome === "accepted"));
});

// ---------- auth & limits (unchanged behaviour) ----------
test("auth: tokens stored hashed, identities link to accounts", async () => {
  const db = await openDb(":memory:"), auth = createAuth(db);
  const { playerId, cookie } = await auth.createPlayer();
  const token = /sid=([a-f0-9]{32})/.exec(cookie)[1];
  assert.equal(await auth.resolve(`sid=${token}`), playerId);
  const hashes = (await db.prepare("SELECT token_hash FROM auth_tokens").all()).map(r => r.token_hash);
  assert.ok(!hashes.includes(token)); assert.ok(hashes.includes(sha256(token)));
  await auth.linkIdentity(playerId, "oidc:x", "u1");
  assert.equal(await auth.playerForIdentity("oidc:x", "u1"), playerId);
  assert.ok(!/Secure/.test(cookie), "no Secure flag locally (http)");
  assert.ok(/; Secure/.test((await createAuth(db, { secure: true }).createPlayer()).cookie), "Secure flag on https hosts");
});

test("rate limiter blocks bursts and resets", () => {
  let t = 0; const allow = createLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([allow("a"), allow("a"), allow("a")], [true, true, false]);
  t = 1000; assert.equal(allow("a"), true);
});
