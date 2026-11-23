"use strict";
/*
 * End-to-end acceptance test for unlimited Soundings, with Playwright (Chromium).
 * Starts its own server on a throwaway database and plays real dives in the browser:
 * topic selection, all four modes, rarity, depth + descent, results, history/review,
 * back-to-back dives with no cooldown, refresh safety, security basics and a mobile run.
 *   node test/e2e.js            (about 2–3 minutes: one question is left to time out for real)
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const E = require("../server/engine");
const bank = require("../server/questions");

const PORT = 8799, URL = `http://localhost:${PORT}/`;
const OUT = path.join(__dirname, "..", "test-results");
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.unlinkSync(path.join(OUT, f));
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soundings-")), "e2e.db");

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log("  ✔", name); }
  catch (e) { results.push([false, name, e.message]); console.log("  ✘", name, "\n     ", e.message.split("\n")[0]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const byText = text => bank.find(q => q.text === text);
const common = text => E.buildCatalog(byText(text)).entries[0].name;
const rare = text => { const c = E.buildCatalog(byText(text)); return [...c.entries].sort((a, b) => a.weight - b.weight)[0].name; };
const TIER_POINTS = Object.fromEntries(E.TIERS.map(t => [t.id, t.points]));

async function waitServer() {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL + "api/state")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server did not start");
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], { env: { ...process.env, PORT, DB_PATH: DB, RL_WRITES: "60", RL_READS: "600" }, stdio: "pipe" });
  server.stderr.on("data", d => { const s = String(d); if (!/ExperimentalWarning|--trace-warnings/.test(s)) process.stderr.write(s); });
  await waitServer();
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/409|Conflict|404/.test(m.text())) errors.push(m.text()); });

  // ---------- helpers ----------
  const st = p => p.evaluate(() => S);
  const qText = p => p.locator("#qText").textContent();
  const submit = async (p, text) => { await p.fill("#answer", text); await p.click("#goBtn"); };
  const waitOpen = p => p.locator("#answer").waitFor({ state: "visible" });
  const waitClosed = p => p.locator("#nextBtn").waitFor({ state: "visible" });
  // waitForFunction needs eval, which the app's CSP (rightly) forbids; poll with evaluate instead
  async function poll(p, fn, arg, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await p.evaluate(fn, arg)) return; await p.waitForTimeout(100); }
    throw new Error("timed out waiting for page condition");
  }
  async function chooseAndBegin(p, mode, topic) {
    if (!(await p.locator("#topics.on").count())) {
      if (await p.locator("#results.on #chooseBtn").count() && !(await p.evaluate(() => reviewing))) await p.click("#results.on #chooseBtn");
      else { await p.evaluate(() => { renderTopics(); show("topics"); }); }
      await p.locator("#topics.on").waitFor();
    }
    await p.click(`.mode-card[data-mode=${mode}]`);
    if (topic !== undefined) await p.click(topic ? `.topic-card[data-topic=${topic}]` : `.topic-card.all`);
    await p.click("#beginBtn");
    await waitOpen(p);
  }
  async function answerAll(p, pick = common) {           // answers every remaining question, returns texts seen
    const seen = [];
    for (;;) {
      const v = await st(p);
      if (v.phase === "done") break;
      seen.push(await qText(p));
      await submit(p, pick(seen[seen.length - 1])); await waitClosed(p);
      await p.click("#nextBtn");                          // hurries the descent if it is still running
      await poll(p, i => S.phase === "done" || (S.idx > i && S.log[S.idx].status === "open"), v.idx);
      if ((await st(p)).phase !== "done") await waitOpen(p);
    }
    await p.locator("#results.on").waitFor();
    return seen;
  }
  async function watchDescent(p) {
    const samples = []; const t0 = Date.now(); let started = false;
    while (Date.now() - t0 < 20000) {
      const d = await p.evaluate(() => ({ ...Sea.descent.debug(), hud: document.getElementById("hudDepth").textContent, aside: document.body.classList.contains("descending") }));
      samples.push(d); if (d.descending) started = true;
      if (started && !d.descending && !d.aside) break;
      await p.waitForTimeout(100);
    }
    return samples;
  }
  function assertDescent(samples, from, to, label) {
    const moving = samples.filter(s => s.descending);
    assert(moving.length >= 4, `${label}: descent not observed (${moving.length} moving samples)`);
    assert(samples.some(s => s.aside), `${label}: panel never stepped aside`);
    const mids = new Set(moving.map(s => Math.round(s.diverM)).filter(m => m > from + 1 && m < to - 1));
    assert(mids.size >= 3, `${label}: Pip teleported (${mids.size} intermediate depths)`);
    for (let i = 1; i < samples.length; i++) assert(samples[i].diverM >= samples[i - 1].diverM - .01, `${label}: Pip moved back up`);
    const first = moving[0], last = samples[samples.length - 1];
    assert(last.camM - first.camM > (to - from) * .5, `${label}: camera did not follow`);
    assert(last.scroll > first.scroll, `${label}: background did not scroll`);
    for (const s of moving) assert(s.diverY > .03 && s.diverY < .97, `${label}: Pip left the frame`);
    assert(new Set(samples.map(s => s.hud)).size >= 3, `${label}: depth readout did not count`);
    assert(Math.abs(last.diverM - to) < .5, `${label}: ended at ${last.diverM} m, expected ${to}`);
  }

  console.log("Desktop (1536×1024)");
  await page.goto(URL);
  await page.locator("#startBtn:not([disabled])").waitFor();
  await page.screenshot({ path: path.join(OUT, "01-title.png") });

  await check("security headers; anonymous read creates no player; no daily countdown anywhere", async () => {
    const r = await fetch(URL + "api/state");
    assert(!r.headers.get("set-cookie"), "GET /api/state set a cookie");
    const s = await r.json();
    assert(s.dive === null && s.topics.length === 20 && s.modes.length === 4, "catalogue missing");
    assert(!("resetAt" in s), "server still sends a daily reset time");
    const h = (await fetch(URL)).headers;
    for (const k of ["content-security-policy", "x-frame-options", "x-content-type-options"]) assert(h.get(k), "missing header " + k);
    assert(!(await page.locator("#nextIn").count()), "countdown element still present");
  });

  // ---------- 1. start a game through the topic screen ----------
  let first;
  await check("1. start a game: title → choose mode + topic → dive", async () => {
    await page.click("#startBtn"); await page.locator("#topics.on").waitFor();
    assert(await page.locator(".topic-card").count() === 20, "20 topic cards expected");
    assert(await page.locator(".mode-card").count() === 4, "4 mode cards expected");
    for (const t of await page.locator(".topic-card").all()) assert(await t.locator("canvas").count() === 1, "topic without icon");
    await page.click(".mode-card[data-mode=quick]");
    if (await page.locator(".topic-card[aria-pressed=true]").count() === 0) assert(await page.locator("#beginBtn").isDisabled(), "Begin enabled before a topic is chosen");
    await page.click(".topic-card[data-topic=space]");
    await page.screenshot({ path: path.join(OUT, "02-topics.png"), fullPage: true });
    await page.click("#beginBtn"); await waitOpen(page);
    first = await st(page);
    assert(first.id && first.mode === "quick" && first.topic === "space", "wrong dive started");
    assert((await page.locator("#count").textContent()) === "1 / 7", "counter");
  });

  // ---------- 2. complete seven questions (reject, retry, rarity, descent, pass, timeout) ----------
  const seen1 = [];
  await check("7+8+9. reject then retry; common answer scores low; depth = score × 10; Pip descends", async () => {
    seen1.push(await qText(page));
    await submit(page, "zzqx not a thing");
    await page.locator("#msg", { hasText: "Not on the chart" }).waitFor({ timeout: 3000 });
    await submit(page, common(seen1[0])); await waitClosed(page);
    const samples = await watchDescent(page), v = await st(page);
    const r = v.log[0];
    assert(r.status === "accepted" && r.points === TIER_POINTS[r.tier], "points don't match tier");
    assert(r.points <= 35, `common answer scored ${r.points}`);
    assert(v.depth === v.score * 10, "depth formula");
    assertDescent(samples, 0, v.depth, "Q1");
    assert((await page.locator("#fbWhy").textContent()).length > 20, "explanation not shown");
  });
  await page.screenshot({ path: path.join(OUT, "03-accepted.png") });

  await check("rare answer: higher tier, reward effect and escort during the descent", async () => {
    await page.click("#nextBtn"); await waitOpen(page);
    seen1.push(await qText(page));
    const from = (await st(page)).depth;
    await submit(page, rare(seen1[1])); await waitClosed(page);
    const samples = await watchDescent(page), v = await st(page), r = v.log[1];
    assert(r.points > v.log[0].points, `rare ${r.points} not above common ${v.log[0].points}`);
    assertDescent(samples, from, v.depth, "rare");
    const escort = { lantern: "escort-angler", leviathan: "escort-manta", fallen: "escort-star" }[r.tier];
    if (escort) assert(samples.some(s => s.visible.includes(escort)), "no " + escort);
  });

  await check("replayed request refused; refresh keeps the question, deadline and Pip's depth", async () => {
    await page.click("#nextBtn"); await waitOpen(page);
    seen1.push(await qText(page));
    const v = await st(page);
    const r = await page.request.post(URL + "api/next", { data: { dive: v.id, seq: v.seq - 1 } });
    assert(r.status() === 409, "replay got " + r.status());
    await page.waitForTimeout(2000);
    await page.reload(); await page.locator("#startBtn:not([disabled])").waitFor();
    assert((await page.locator("#startBtn").textContent()).toUpperCase().includes("RESUME"), "no resume");
    await page.click("#startBtn"); await waitOpen(page);
    const w = await st(page);
    assert(w.id === v.id && w.log[w.idx].deadline === v.log[v.idx].deadline, "dive or deadline changed");
    assert(await page.evaluate(() => Sea.descent.debug().diverM) === w.depth, "Pip reset on refresh");
  });

  await check("timer: a question left alone times out with zero points", async () => {
    await page.locator("#fbTitle", { hasText: /time/i }).waitFor({ timeout: 40000 });
    assert((await st(page)).log[2].points === 0, "timeout scored");
  });

  await check("pass records zero and moves on", async () => {
    await page.click("#nextBtn"); await waitOpen(page);
    seen1.push(await qText(page));
    await page.click("#passBtn"); await waitClosed(page);
    assert((await st(page)).log[3].status === "passed", "not passed");
    await page.click("#nextBtn"); await waitOpen(page);
  });

  let done1;
  await check("2. complete all seven questions → results with score, depth and rarities", async () => {
    seen1.push(...await answerAll(page));
    done1 = await st(page);
    assert(done1.phase === "done" && done1.log.length === 7, "dive not complete");
    const sum = done1.log.reduce((s, r) => s + (r.points || 0), 0);
    assert(done1.score === sum, "score ≠ sum of rounds");
    await page.waitForTimeout(1100);
    assert(Number((await page.locator("#resScore").textContent()).replace(/,/g, "")) === sum, "score on screen");
    assert((await page.locator("#resMax").textContent()).includes("700"), "out of 700 missing");
    assert((await page.locator("#resTitle").textContent()).includes((sum * 10).toLocaleString("en-US") + " m"), "final depth missing");
    assert(await page.locator("#collection .cell").count() === 7, "rarity rewards missing");
    assert(await page.locator("#againBtn").isVisible() && await page.locator("#chooseBtn").isVisible(), "Play again / Choose another topic missing");
    assert(await page.evaluate(() => Sea.descent.debug().diverM) === sum * 10, "Pip's depth ≠ score × 10");
  });
  await page.screenshot({ path: path.join(OUT, "04-results.png"), fullPage: true });

  await check("5+6. every question was from the chosen topic and none repeated", async () => {
    const texts = done1.log.map(r => r.text);
    assert(new Set(texts).size === 7, "repeat inside a dive");
    for (const t of texts) assert(byText(t).topic === "space", "off-topic question: " + t);
  });

  // ---------- 3. play again immediately ----------
  let second;
  await check("3+12. Play again starts a fresh dive immediately — no cooldown", async () => {
    const t0 = Date.now();
    await page.click("#againBtn"); await waitOpen(page);
    second = await st(page);
    assert(Date.now() - t0 < 5000, "slow restart");
    assert(second.id !== done1.id && second.mode === "quick" && second.topic === "space" && second.score === 0, "not a fresh dive");
    assert(await page.evaluate(() => Sea.descent.debug().diverM) === 0, "Pip not back at the surface");
  });
  await check("6. the next dive on the same topic prefers questions not just played", async () => {
    const seen2 = await answerAll(page);
    // pool is 30+ per topic, so dive 2 should repeat nothing from dive 1
    for (const t of seen2) assert(!done1.log.some(r => r.text === t), "repeated from last dive: " + t);
    assert(new Set(seen2).size === 7, "repeat inside dive 2");
  });

  // ---------- 4. choose a different topic ----------
  await check("4+5. Choose another topic → movies; every question is about movies", async () => {
    await page.click("#chooseBtn"); await page.locator("#topics.on").waitFor();
    await chooseAndBegin(page, "quick", "movies");
    const texts = await answerAll(page);
    for (const t of texts) assert(byText(t).topic === "movies", "off-topic: " + t);
  });

  // ---------- modes ----------
  await check("Mixed Dive: seven questions from seven different topics", async () => {
    await page.click("#chooseBtn"); await page.locator("#topics.on").waitFor();
    await page.click(".mode-card[data-mode=mixed]");
    assert(await page.locator(".topic-card[data-topic=space]").isDisabled(), "topics should be locked for mixed");
    await page.click("#beginBtn"); await waitOpen(page);
    const texts = await answerAll(page);
    assert(new Set(texts.map(t => byText(t).topic)).size === 7, "topics repeated in mixed");
  });
  await check("Topic Special: easy → hard, 30 s timer and a mastery rank", async () => {
    await chooseAndBegin(page, "special", "dinosaurs");
    assert((await st(page)).questionMs === 30000, "special timer should be 30 s");
    const texts = await answerAll(page);
    const d = texts.map(t => E.DIFFICULTY[byText(t).difficulty]);
    assert(JSON.stringify(d) === JSON.stringify([...d].sort((a, b) => a - b)), "difficulty not rising: " + d);
    assert(/mastery/i.test(await page.locator("#resMastery").textContent()), "no mastery rank");
  });
  await check("Endless Dive: air tanks, a pass costs one, Surface ends with the score kept", async () => {
    await chooseAndBegin(page, "endless", null);
    assert(await page.locator("#tanks .tank.full").count() === 3, "3 tanks expected");
    await submit(page, common(await qText(page))); await waitClosed(page); await page.click("#nextBtn"); await waitOpen(page);
    await page.click("#passBtn"); await waitClosed(page);
    assert(await page.locator("#tanks .tank.full").count() === 2, "pass did not cost a tank");
    const score = (await st(page)).score;
    await page.click("#surfaceBtn"); await page.locator("#results.on").waitFor();
    const v = await st(page);
    assert(v.endReason === "surfaced" && v.score === score, "surface did not keep the score");
    assert((await page.locator("#resTab").textContent()) === "Surfaced", "results tab");
    await page.screenshot({ path: path.join(OUT, "05-endless-results.png"), fullPage: true });
  });
  await check("Endless Dive: three passes run out of air", async () => {
    await chooseAndBegin(page, "endless", "art");
    for (let i = 0; i < 3; i++) { await page.click("#passBtn"); await waitClosed(page); await page.click("#nextBtn"); if (i < 2) await waitOpen(page); }
    await page.locator("#results.on").waitFor();
    assert((await st(page)).endReason === "out-of-air", "not out of air");
  });

  // ---------- 10 + 11. results saved, previous dives reviewed ----------
  await check("10+11. results are saved; the Logbook lists past dives and opens a review", async () => {
    await page.click("#results [data-logbook]"); await page.locator("#logbook.on").waitFor();
    const n = await page.locator("#diveList button").count();
    assert(n === 7, `expected 7 finished dives in history, got ${n}`);
    const cells = await page.locator("#logGrid div").allInnerTexts();
    assert(cells.some(c => /DIVES COMPLETED\s+7/i.test(c)), "dives completed stat: " + cells[0]);
    assert((await page.locator("#logRarest").textContent()).length > 10, "rarest answer missing");
    assert(await page.locator("#logFav li").count() >= 1, "favourite topics missing");
    assert(await page.locator("#logRecords li").count() === 4, "records per mode missing");
    await page.screenshot({ path: path.join(OUT, "06-logbook.png"), fullPage: true });
    await page.locator(`#diveList button[data-dive="${done1.id}"]`).click();
    await page.locator("#results.on").waitFor();
    assert((await page.locator("#resTab").textContent()) === "Dive log", "not in review mode");
    assert(Number((await page.locator("#resScore").textContent()).replace(/,/g, "")) === done1.score, "reviewed score differs");
    assert(await page.locator("#breakdown li").count() === 7, "reviewed rounds missing");
    await page.screenshot({ path: path.join(OUT, "07-review.png"), fullPage: true });
    const other = await (await fetch(URL + "api/dives/" + done1.id)).json();
    assert(other.error === "no-dive", "another browser could read this dive");
  });

  await check("12. back-to-back dives through the API: five in a row, all accepted", async () => {
    for (let i = 0; i < 5; i++) { const r = await page.request.post(URL + "api/dive", { data: { mode: "mixed" } }); assert(r.status() === 200, "dive " + i + " refused: " + r.status()); }
  });

  // ---------- descent scene at depth (incl. Endless depths) ----------
  await check("descent scene at 100 / 1,000 / 3,000 / 5,000 / 7,000 / 10,900 m", async () => {
    await page.reload(); await page.locator("#startBtn:not([disabled])").waitFor();
    await page.click("#startBtn"); await waitOpen(page);
    await page.evaluate(() => document.querySelectorAll(".screen,.bar").forEach(e => e.style.visibility = "hidden"));
    const info = [];
    for (const m of [100, 1000, 3000, 5000, 7000, 10900]) {
      await page.evaluate(d => Sea.descent.place(d), m); await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, "08-depth-" + String(m).padStart(5, "0") + "m.png") });
      info.push(await page.evaluate(() => { const c = document.getElementById("sea"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return { ...Sea.descent.debug(), lum: s / (d.length / 4) }; }));
    }
    for (const i of info) assert(i.visible.includes("diver"), "Pip missing at " + i.diverM);
    for (let i = 1; i < 5; i++) assert(info[i].lum < info[i - 1].lum, "not darker: " + info.map(x => Math.round(x.lum)).join(" > "));
    assert(info[0].visible.includes("sunrays") && info[2].sunlight < .01, "sunlight wrong");
    assert(info[5].visible.includes("trench-floor"), "no trench floor at 10,900 m");
    await page.evaluate(() => document.querySelectorAll(".screen,.bar").forEach(e => e.style.visibility = ""));
  });

  await check("cross-site POST without JSON is refused", async () => {
    const r = await fetch(URL + "api/dive", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "mode=quick" });
    assert(r.status === 415, "got " + r.status);
  });

  // ---------- mobile ----------
  console.log("Mobile (390×844)");
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const m = await mctx.newPage();
  m.on("pageerror", e => errors.push("mobile: " + e.message));
  await check("mobile: choose topic, dive with descent, play again, no horizontal scroll", async () => {
    await m.goto(URL); await m.locator("#startBtn:not([disabled])").waitFor();
    await m.tap("#startBtn"); await m.locator("#topics.on").waitFor();
    await m.screenshot({ path: path.join(OUT, "09-mobile-topics.png"), fullPage: true });
    await m.tap(".mode-card[data-mode=quick]"); await m.tap(".topic-card[data-topic=marine]"); await m.tap("#beginBtn");
    await waitOpen(m);
    const q = await qText(m);
    assert(byText(q).topic === "marine", "off-topic on mobile");
    await m.fill("#answer", common(q)); await m.tap("#goBtn"); await waitClosed(m);
    const samples = await watchDescent(m);
    assertDescent(samples, 0, (await st(m)).depth, "mobile");
    await m.screenshot({ path: path.join(OUT, "10-mobile-question.png") });
    await m.tap("#nextBtn"); await waitOpen(m);
    await answerAll(m);
    await m.screenshot({ path: path.join(OUT, "11-mobile-results.png"), fullPage: true });
    const [sw, iw] = await m.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert(sw <= iw, `horizontal overflow ${sw} > ${iw}`);
    await m.tap("#againBtn"); await waitOpen(m);
    assert((await st(m)).score === 0, "play again on mobile failed");
  });

  await check("no uncaught page errors", async () => assert(errors.length === 0, errors.join(" | ")));

  await browser.close(); server.kill();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
