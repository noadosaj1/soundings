"use strict";
/*
 * Soundings game service — unlimited dives.
 *
 * Every game is a dive with its own id, mode and (optional) topic. Players can start a new dive
 * at any time; starting one while another is still running closes the old one as "abandoned".
 *
 * Integrity rules (unchanged from the daily version)
 *  - all scoring happens here; the client only displays
 *  - every mutation names the dive and carries its `seq`; stale or replayed requests get 409
 *  - deadlines are server timestamps; answers after deadline + GRACE_MS are refused
 *  - a round closes exactly once (accepted / passed / timeout) inside a transaction
 *  - rarity for a question is read from a per-UTC-day snapshot of recorded answers, so everyone
 *    playing that question on the same day is scored against the same data
 */
const crypto = require("node:crypto");
const E = require("./engine");
const { TOPICS, MODES, GROUPS } = require("./topics");

class GameError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const MAX_ANSWER_LEN = 60;
const MAX_ATTEMPTS = 30;
const RECENT_WINDOW = 150;           // how many past questions count as "recently played"
const secureRandom = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

function createGame({ db, bank, now = () => Date.now(), random = secureRandom }) {
  const questions = new Map(bank.map(q => [q.id, q]));
  const catalogs = new Map(bank.map(q => [q.id, E.buildCatalog(q)]));
  const topicById = new Map(TOPICS.map(t => [t.id, t]));

  const sql = {
    snapshot:    db.prepare("SELECT counts, total FROM rarity_snapshot WHERE day = ? AND qid = ?"),
    addSnapshot: db.prepare("INSERT OR IGNORE INTO rarity_snapshot (day, qid, counts, total) VALUES (?, ?, ?, ?)"),
    counts:      db.prepare("SELECT answer_id, n FROM answer_counts WHERE qid = ?"),
    allCounts:   db.prepare("SELECT qid, SUM(n) AS n FROM answer_counts GROUP BY qid"),
    bump:        db.prepare("INSERT INTO answer_counts (qid, answer_id, n) VALUES (?, ?, 1) ON CONFLICT (qid, answer_id) DO UPDATE SET n = n + 1"),
    dive:        db.prepare("SELECT * FROM dives WHERE id = ?"),
    active:      db.prepare("SELECT * FROM dives WHERE player = ? AND phase != 'done' ORDER BY started_at DESC LIMIT 1"),
    addDive:     db.prepare("INSERT INTO dives (id, player, mode, topic, phase, idx, seq, score, lives, qids, question_ms, started_at) VALUES (?, ?, ?, ?, 'question', 0, 1, 0, ?, ?, ?, ?)"),
    setDive:     db.prepare("UPDATE dives SET phase = ?, idx = ?, seq = ?, score = ?, lives = ?, qids = ?, finished_at = ?, end_reason = ? WHERE id = ?"),
    abandonRnds: db.prepare("UPDATE dive_rounds SET status = 'timeout', closed_at = ? WHERE status = 'open' AND dive IN (SELECT id FROM dives WHERE player = ? AND phase != 'done')"),
    abandon:     db.prepare("UPDATE dives SET phase = 'done', finished_at = ?, end_reason = 'abandoned', seq = seq + 1 WHERE player = ? AND phase != 'done'"),
    rounds:      db.prepare("SELECT * FROM dive_rounds WHERE dive = ? ORDER BY n"),
    round:       db.prepare("SELECT * FROM dive_rounds WHERE dive = ? AND n = ?"),
    addRound:    db.prepare("INSERT INTO dive_rounds (dive, n, qid, started_at, deadline, status) VALUES (?, ?, ?, ?, ?, 'open')"),
    closeRound:  db.prepare("UPDATE dive_rounds SET status = ?, answer_id = ?, answer_raw = ?, tier = ?, points = ?, share = ?, live_total = ?, closed_at = ? WHERE dive = ? AND n = ? AND status = 'open'"),
    attempts:    db.prepare("SELECT raw, accepted FROM dive_attempts WHERE dive = ? AND n = ? ORDER BY at"),
    attemptN:    db.prepare("SELECT COUNT(*) AS c FROM dive_attempts WHERE dive = ? AND n = ?"),
    hasAttempt:  db.prepare("SELECT 1 FROM dive_attempts WHERE dive = ? AND n = ? AND norm = ?"),
    addAttempt:  db.prepare("INSERT INTO dive_attempts (dive, n, norm, raw, accepted, at) VALUES (?, ?, ?, ?, ?, ?)"),
    recent:      db.prepare("SELECT r.qid FROM dive_rounds r JOIN dives d ON d.id = r.dive WHERE d.player = ? ORDER BY r.started_at DESC LIMIT " + RECENT_WINDOW),
    finished:    db.prepare("SELECT d.*, (SELECT COUNT(*) FROM dive_rounds WHERE dive = d.id) AS n_rounds, (SELECT COUNT(*) FROM dive_rounds WHERE dive = d.id AND status = 'accepted') AS n_found FROM dives d WHERE player = ? AND phase = 'done' AND end_reason != 'abandoned' ORDER BY finished_at DESC"),
    statusCounts:db.prepare("SELECT r.status, COUNT(*) AS n FROM dive_rounds r JOIN dives d ON d.id = r.dive WHERE d.player = ? AND r.status != 'open' AND (d.end_reason IS NULL OR d.end_reason != 'abandoned') GROUP BY r.status"),
    tierCounts:  db.prepare("SELECT r.tier, COUNT(*) AS n FROM dive_rounds r JOIN dives d ON d.id = r.dive WHERE d.player = ? AND r.status = 'accepted' AND (d.end_reason IS NULL OR d.end_reason != 'abandoned') GROUP BY r.tier"),
    rarest:      db.prepare("SELECT r.* FROM dive_rounds r JOIN dives d ON d.id = r.dive WHERE d.player = ? AND r.status = 'accepted' ORDER BY r.share ASC, r.closed_at ASC LIMIT 1"),
  };

  const tx = fn => db.tx(fn);

  // ---------- rarity (frozen per UTC day per question) ----------
  async function frozenCounts(qid, t = now()) {
    const day = E.dayIndex(t);
    let s = (await sql.snapshot.get(day, qid));
    if (!s) {
      const obj = {}; let total = 0;
      for (const r of (await sql.counts.all(qid))) { obj[r.answer_id] = r.n; total += r.n; }
      (await sql.addSnapshot.run(day, qid, JSON.stringify(obj), total));
      s = (await sql.snapshot.get(day, qid));
    }
    return new Map(Object.entries(JSON.parse(s.counts)));
  }

  // ---------- helpers ----------
  async function recentFor(pid) {
    const m = new Map();
    (await sql.recent.all(pid)).forEach((r, i) => { if (!m.has(r.qid)) m.set(r.qid, i); });
    return m;
  }

  async function ownDive(pid, id) {
    const d = typeof id === "string" ? (await sql.dive.get(id)) : null;
    if (!d || d.player !== pid) throw new GameError(404, "no-dive", "That dive was not found.");
    return d;
  }

  function checkSeq(d, seq) {
    if (seq !== d.seq) throw new GameError(409, "stale", "That action was already handled.");
  }

  /** Close an open round whose deadline (plus grace) has passed; endless dives lose an air tank. */
  async function settle(d, t = now()) {
    if (!d || d.phase !== "question") return d;
    const r = (await sql.round.get(d.id, d.idx));
    if (r && r.status === "open" && t > r.deadline + E.GRACE_MS) {
      await tx(async () => {
        if ((await sql.closeRound.run("timeout", null, null, null, 0, null, null, t, d.id, d.idx)).changes) {
          const lives = d.lives == null ? null : Math.max(0, d.lives - 1);
          (await sql.setDive.run("between", d.idx, d.seq, d.score, lives, d.qids, null, null, d.id));
        }
      });
      return (await sql.dive.get(d.id));
    }
    return d;
  }

  async function openRound(diveId, n, qid, t, ms) { (await sql.addRound.run(diveId, n, qid, t, t + ms)); }

  // ---------- actions ----------
  /** Start a new dive immediately. Any unfinished dive is closed as abandoned. */
  async function start(pid, { mode, topic } = {}) {
    const M = MODES[mode];
    if (!M) throw new GameError(400, "bad-mode", "Pick a game mode.");
    if (M.topic === "required" && !topicById.has(topic)) throw new GameError(400, "bad-topic", "Pick a topic for this mode.");
    if (M.topic === "optional" && topic != null && !topicById.has(topic)) throw new GameError(400, "bad-topic", "Unknown topic.");
    const useTopic = M.topic === "none" ? null : (topic ?? null);
    const t = now(), id = "d_" + crypto.randomBytes(9).toString("hex");
    const planned = M.id === "endless" ? 1 : M.rounds;
    const qids = E.pickQuestions({ bank, mode: M.id, topic: useTopic, count: planned, recent: await recentFor(pid), random });
    if (qids.length < planned) throw new GameError(409, "no-questions", "Not enough questions in this topic yet.");
    await tx(async () => {
      (await sql.abandonRnds.run(t, pid)); (await sql.abandon.run(t, pid));
      (await sql.addDive.run(id, pid, M.id, useTopic, M.lives ?? null, JSON.stringify(qids), M.questionMs, t));
      await openRound(id, 0, qids[0], t, M.questionMs);
    });
    return await state(pid, id);
  }

  async function answer(pid, { dive, seq, text }) {
    const t = now();
    let d = await settle(await ownDive(pid, dive), t);
    const raw = String(text ?? "").trim().slice(0, MAX_ANSWER_LEN);
    const result = await tx(async () => {
      d = (await sql.dive.get(d.id));
      checkSeq(d, seq);
      if (d.phase !== "question") throw new GameError(409, "closed", "This question is closed.");
      const r = (await sql.round.get(d.id, d.idx));
      if (t > r.deadline + E.GRACE_MS) throw new GameError(409, "expired", "Time is up.");
      const q = questions.get(r.qid), cat = catalogs.get(r.qid);
      const m = E.match(q, cat, raw);
      if (!m.key) throw new GameError(400, "empty", "Type an answer first.");
      if ((await sql.hasAttempt.get(d.id, d.idx, m.key))) return { outcome: "repeat" };
      if ((await sql.attemptN.get(d.id, d.idx)).c >= MAX_ATTEMPTS) throw new GameError(429, "too-many", "Too many attempts on this question.");
      (await sql.addAttempt.run(d.id, d.idx, m.key, raw, m.ok ? 1 : 0, t));
      if (!m.ok) { (await sql.setDive.run("question", d.idx, d.seq + 1, d.score, d.lives, d.qids, null, null, d.id)); return { outcome: "rejected", reason: m.reason }; }
      const { share, liveTotal } = E.shareOf(cat, m.entry.id, await frozenCounts(r.qid, t));
      const tier = E.tierForShare(share);
      (await sql.closeRound.run("accepted", m.entry.id, raw, tier.id, tier.points, share, liveTotal, t, d.id, d.idx));
      (await sql.bump.run(r.qid, m.entry.id));                    // feeds tomorrow's snapshot
      (await sql.setDive.run("between", d.idx, d.seq + 1, d.score + tier.points, d.lives, d.qids, null, null, d.id));
      return { outcome: "accepted", fuzzy: m.fuzzy };
    });
    return { ...(await state(pid, d.id)), result };
  }

  async function pass(pid, { dive, seq }) {
    const t = now();
    let d = await settle(await ownDive(pid, dive), t);
    await tx(async () => {
      d = (await sql.dive.get(d.id));
      checkSeq(d, seq);
      if (d.phase !== "question") throw new GameError(409, "closed", "This question is closed.");
      (await sql.closeRound.run("passed", null, null, null, 0, null, null, t, d.id, d.idx));
      const lives = d.lives == null ? null : Math.max(0, d.lives - 1);
      (await sql.setDive.run("between", d.idx, d.seq + 1, d.score, lives, d.qids, null, null, d.id));
    });
    return await state(pid, d.id);
  }

  async function next(pid, { dive, seq }) {
    const t = now();
    let d = await settle(await ownDive(pid, dive), t);
    await tx(async () => {
      d = (await sql.dive.get(d.id));
      checkSeq(d, seq);
      if (d.phase !== "between") throw new GameError(409, "not-ready", "Finish this question first.");
      const M = MODES[d.mode] || MODES.quick, qids = JSON.parse(d.qids);
      const finish = async reason => (await sql.setDive.run("done", d.idx, d.seq + 1, d.score, d.lives, d.qids, t, reason, d.id));
      if (d.mode === "endless") {
        if (d.lives <= 0) return finish("out-of-air");
        if (d.idx + 1 >= M.rounds) return finish("complete");
        const lastTopic = questions.get(qids[qids.length - 1])?.topic;
        const [q] = E.pickQuestions({ bank, mode: "endless", topic: d.topic, count: 1, asked: new Set(qids), recent: await recentFor(pid), random, avoidTopic: d.topic ? null : lastTopic });
        if (!q) return finish("complete");
        qids.push(q);
      } else if (d.idx + 1 >= qids.length) return finish(d.mode === "daily" ? "legacy" : "complete");
      await openRound(d.id, d.idx + 1, qids[d.idx + 1], t, d.question_ms);
      (await sql.setDive.run("question", d.idx + 1, d.seq + 1, d.score, d.lives, JSON.stringify(qids), null, null, d.id));
    });
    return await state(pid, d.id);
  }

  /** Endless only: stop diving now and keep the score. An open question closes with no penalty. */
  async function surface(pid, { dive, seq }) {
    const t = now();
    let d = await settle(await ownDive(pid, dive), t);
    await tx(async () => {
      d = (await sql.dive.get(d.id));
      checkSeq(d, seq);
      if (d.mode !== "endless") throw new GameError(409, "not-endless", "Only Endless dives can surface early.");
      if (d.phase === "done") throw new GameError(409, "closed", "This dive is over.");
      if (d.phase === "question") (await sql.closeRound.run("passed", null, null, null, 0, null, null, t, d.id, d.idx));
      (await sql.setDive.run("done", d.idx, d.seq + 1, d.score, d.lives, d.qids, t, "surfaced", d.id));
    });
    return await state(pid, d.id);
  }

  // ---------- read model ----------
  const topicName = id => topicById.get(id)?.name ?? null;
  const modeName = id => MODES[id]?.name ?? (id === "daily" ? "Daily Dive (legacy)" : id);

  async function roundView(r, closed) {
    const q = questions.get(r.qid), cat = catalogs.get(r.qid);
    const attempts = (await sql.attempts.all(r.dive, r.n));
    const out = {
      n: r.n, text: q ? q.text : "(retired question)", hint: q?.hint ?? "", topic: q?.topic ?? null, topicName: topicName(q?.topic),
      difficulty: q?.difficulty ?? null, status: r.status, startedAt: r.started_at, deadline: r.deadline,
      rejected: attempts.filter(a => !a.accepted).map(a => a.raw),
    };
    if (closed && q) {
      const entry = r.answer_id && cat.byId.get(r.answer_id);
      Object.assign(out, {
        answer: entry ? entry.name : null, typed: r.answer_raw, tier: r.tier, points: r.points, closedAt: r.closed_at,
        share: r.share, liveTotal: r.live_total, explain: q.explain,
        top: E.topAnswers(cat, await frozenCounts(r.qid), 3).map(a => a.name),
      });
    }
    return out;
  }

  const MASTERY = [[7, "Abyss master"], [5, "Deep diver"], [3, "Reef explorer"], [1, "Snorkeller"], [0, "Still at the surface"]];
  async function diveView(d) {
    const M = MODES[d.mode];
    const log = await Promise.all((await sql.rounds.all(d.id)).map(r => roundView(r, r.status !== "open")));
    const found = log.filter(r => r.status === "accepted").length;
    const out = {
      id: d.id, mode: d.mode, modeName: modeName(d.mode), topic: d.topic, topicName: topicName(d.topic),
      phase: d.phase, idx: d.idx, seq: d.seq, score: d.score, depth: E.depthFor(d.score), zone: E.zoneFor(E.depthFor(d.score)),
      rounds: d.mode === "endless" ? null : JSON.parse(d.qids).length, maxScore: d.mode === "endless" ? null : JSON.parse(d.qids).length * 100,
      lives: d.lives, maxLives: M?.lives ?? null, questionMs: d.question_ms,
      startedAt: d.started_at, finishedAt: d.finished_at, endReason: d.end_reason, found, log,
    };
    if (d.phase === "done" && d.mode === "special") out.mastery = MASTERY.find(([n]) => found >= n)[1];
    return out;
  }

  async function playerStats(pid) {
    const empty = { dives: 0, questionsAnswered: 0, accepted: 0, passed: 0, timedOut: 0, answeredRate: 0, bestScore: 0, deepest: 0,
      average: 0, totalPoints: 0, tierCounts: {}, tiersFound: [], rarest: null, favoriteTopics: [], records: {}, recent: [] };
    if (!pid) return empty;
    // independent reads run in parallel: on a remote database each one is a network round trip
    const [done, stRows, tierRows, rr] = await Promise.all([sql.finished.all(pid), sql.statusCounts.all(pid), sql.tierCounts.all(pid), sql.rarest.get(pid)]);
    const st = Object.fromEntries(stRows.map(r => [r.status, r.n]));
    const tierCounts = Object.fromEntries(tierRows.filter(r => r.tier).map(r => [r.tier, r.n]));
    const answered = (st.accepted || 0) + (st.passed || 0) + (st.timeout || 0);
    const sevens = done.filter(d => d.mode !== "endless");
    const records = {};
    for (const d of done) {
      const r = records[d.mode] ??= { mode: d.mode, modeName: modeName(d.mode), bestScore: 0, bestDive: null, dives: 0 };
      r.dives++;
      if (d.score > r.bestScore || !r.bestDive) { r.bestScore = d.score; r.bestDive = d.id; }
      if (d.mode === "endless") r.longestRun = Math.max(r.longestRun || 0, d.n_rounds);
    }
    const byTopic = {};
    for (const d of done) if (d.topic) { const x = byTopic[d.topic] ??= { topic: d.topic, name: topicName(d.topic), dives: 0, total: 0, best: 0 }; x.dives++; x.total += d.score; x.best = Math.max(x.best, d.score); }
    const favoriteTopics = Object.values(byTopic).map(x => ({ ...x, average: Math.round(x.total / x.dives) }))
      .sort((a, b) => b.dives - a.dives || b.total - a.total).slice(0, 3);
    let rarest = null;
    if (rr) { const q = questions.get(rr.qid), e = q && catalogs.get(rr.qid).byId.get(rr.answer_id);
      rarest = { answer: e ? e.name : rr.answer_raw, question: q ? q.text : "", tier: rr.tier, points: rr.points, share: rr.share, dive: rr.dive }; }
    return {
      dives: done.length, questionsAnswered: answered, accepted: st.accepted || 0, passed: st.passed || 0, timedOut: st.timeout || 0,
      answeredRate: answered ? Math.round(100 * (st.accepted || 0) / answered) : 0,
      bestScore: done.reduce((m, d) => Math.max(m, d.score), 0),
      deepest: E.depthFor(done.reduce((m, d) => Math.max(m, d.score), 0)),
      average: sevens.length ? Math.round(sevens.reduce((s, d) => s + d.score, 0) / sevens.length) : 0,
      totalPoints: done.reduce((s, d) => s + d.score, 0),
      tierCounts, tiersFound: Object.keys(tierCounts), rarest, favoriteTopics, records,
      recent: done.slice(0, 14).reverse().map(d => ({ id: d.id, mode: d.mode, topic: d.topic, score: d.score, depth: E.depthFor(d.score) })),
    };
  }

  async function topicsInfo() {
    const recorded = new Map((await sql.allCounts.all()).map(r => [r.qid, r.n]));
    return TOPICS.map(t => {
      const qs = bank.filter(q => q.topic === t.id);
      return { ...t, questions: qs.length, answersRecorded: qs.reduce((s, q) => s + (recorded.get(q.id) || 0), 0) };
    });
  }

  /** Full state for the client: player stats, catalogue, and the dive in focus (given id, else active). */
  async function state(pid, diveId) {
    const t = now();
    let d = null;
    if (pid && diveId) d = await ownDive(pid, diveId);
    else if (pid) d = (await sql.active.get(pid)) || null;
    d = await settle(d, t);
    const [topics, player, dive] = await Promise.all([topicsInfo(), playerStats(pid), d ? diveView(d) : null]);
    return {
      serverNow: t, metresPerPoint: E.METRES_PER_POINT, graceMs: E.GRACE_MS,
      tiers: E.TIERS.map(({ id, name, points, creature }) => ({ id, name, points, creature })),
      zones: E.ZONES, groups: GROUPS, topics, modes: Object.values(MODES), player, dive,
    };
  }

  async function history(pid, { limit = 50 } = {}) {
    if (!pid) return { dives: [] };
    return { dives: (await sql.finished.all(pid)).slice(0, Math.min(200, limit)).map(d => ({
      id: d.id, mode: d.mode, modeName: modeName(d.mode), topic: d.topic, topicName: topicName(d.topic),
      score: d.score, depth: E.depthFor(d.score), questions: d.n_rounds, found: d.n_found,
      startedAt: d.started_at, finishedAt: d.finished_at, endReason: d.end_reason,
    })) };
  }

  async function review(pid, id) {
    const d = await ownDive(pid, id);
    if (d.phase !== "done") throw new GameError(409, "not-done", "This dive is still in progress.");
    return { serverNow: now(), dive: await diveView(d) };
  }

  return { start, answer, pass, next, surface, state, history, review, GameError };
}

module.exports = { createGame, GameError };
