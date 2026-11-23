"use strict";
/*
 * DescentScene — the visible dive.
 *
 * A pixel explorer ("Pip": brass helmet, cyan visor, orange suit, kicking fins, headlamp)
 * sinks through a world laid out in METRES. A spring camera follows Pip; the ocean scrolls
 * past in parallax layers (far cliffs 0.35×, mid rocks 0.7×, creatures 1×, foreground 1.4×,
 * plus world-anchored snow, plankton and bubbles). Water colour, sunlight, darkness and the
 * creatures on show all come from the depth being looked at, so each zone looks different.
 *
 * The scene never invents depth: the game calls place(m) (instant, e.g. on load) or
 * descend(m, tier) (animated, after a scored answer). 1 point = 10 m is applied by the caller.
 *
 * Usage: const D = createDescentScene({ spriteCanvas });  D.resize(W, H, PX);  D.draw(ctx, dt);
 *   dt is in ~33 ms frame units (same as the host loop). Callbacks: D.onDepth(m), D.onZone(name).
 */
window.createDescentScene = function createDescentScene({ spriteCanvas }) {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ZONES = [[0, "Sunlight zone"], [200, "Twilight zone"], [1000, "Midnight zone"], [4000, "Abyssal zone"], [6000, "Hadal zone"]];
  const FLOOR_M = 11000;                // trench floor (about Challenger Deep); only Endless dives get this far
  const MAX_PIP = FLOOR_M - 40;         // Pip stops just above the floor; the HUD still shows the true depth
  const zoneAt = m => { let z = ZONES[0][1]; for (const [f, n] of ZONES) if (m >= f) z = n; return z; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ramp = (m, a, b) => clamp((m - a) / (b - a), 0, 1);
  const lerp = (a, b, f) => a + (b - a) * f;
  const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  function hash(n) { n |= 0; n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; }
  const h2 = (a, b) => hash(Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263));
  function noise(x, seed) { const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f); return lerp(h2(i, seed), h2(i + 1, seed), s); }
  const fbm = (x, seed) => (noise(x, seed) + noise(x * 2.13, seed + 7) * .5 + noise(x * 4.7, seed + 13) * .25) / 1.75;

  // water colour by depth (metres) — surface teal → twilight blue → near-black hadal
  const WATER = [[0, 63, 169, 184], [60, 33, 122, 142], [200, 22, 70, 92], [600, 14, 44, 76], [1000, 9, 29, 56], [2500, 5, 16, 32], [4000, 4, 9, 20], [6000, 3, 5, 13], [7600, 2, 3, 8]];
  function water(m) {
    if (m <= 0) return [63, 169, 184];
    for (let i = 1; i < WATER.length; i++) if (m <= WATER[i][0]) { const a = WATER[i - 1], b = WATER[i], f = (m - a[0]) / (b[0] - a[0]); return [lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)]; }
    const l = WATER[WATER.length - 1]; return [l[1], l[2], l[3]];
  }
  const sunlight = m => Math.exp(-Math.max(0, m) / 190);            // fraction of daylight left
  const darkness = m => clamp(1 - Math.exp(-Math.max(0, m - 120) / 700), 0, .8);

  // ---------- the explorer ----------
  const DIVER = [
    "...............l....",
    ".............kkkkk..",
    "......kkkkk.kbBBBbk.",
    ".....kttttk.kbvvVbbk",
    "....kooooookbvvvvbbk",
    "....koOooooobvvvvbbk",
    "....koOOooookbbbbbk.",
    "....kOOOOookkkkkkk..",
    ".....kkkkkk.kok.....",
    "............kk......",
    "....................",
    "....................",
  ];
  const FINS = [
    { row: 2, rows: ["kk..", "kfk.", "kffk", "kffk", "kfk.", "kk.."] },
    { row: 4, rows: ["kk..", "kffk", "kfFk", "kffk", "kk.."] },
    { row: 5, rows: ["kk..", "kfk.", "kffk", "kffk", "kfk.", "kk.."] },
  ];
  const DPAL = { k: "#0a1a24", l: "#fffbd0", b: "#b5762e", B: "#f2c070", v: "#3cc7c0", V: "#d6fffb", t: "#e8c84a", o: "#ff8a3d", O: "#c45a1e", f: "#2fa59a", F: "#1d6e66" };
  const SNAILFISH = ["...kkkk.......", ".kkppppkk.....", "kpwkpppppkkk..", "kppppppppppppk", ".kpppppppkkk..", "..kkkkkkk....."];
  function paint(c, rows, pal, ox = 0, oy = 0) {
    const x = c.getContext("2d");
    rows.forEach((r, y) => [...r].forEach((ch, i) => { if (ch !== "." && pal[ch]) { x.fillStyle = pal[ch]; x.fillRect(ox + i, oy + y, 1, 1); } }));
  }
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
  const DS = 2;                         // Pip is drawn at 2× so they read as the hero of the scene
  const diverFrames = [0, 1, 2, 1].map(fi => { const c = mk(20, 12); paint(c, DIVER, DPAL); paint(c, FINS[fi].rows, DPAL, 0, FINS[fi].row); return c; });
  const snailfish = mk(14, 6); paint(snailfish, SNAILFISH, { k: "#7a5060", p: "#f3c6d2", w: "#ffffff" });

  // ---------- state ----------
  let W = 1, H = 1, PX = 4, PXM = 1;    // PXM = low-res pixels per metre
  let t = 0, diverM = 0, camM = 0, camVel = 0, speed = 0, angle = 0, lamp = 0, shake = 0, flash = 0;
  let anchor = { x: .5, y: .45 }, anchorTo = { x: .5, y: .45 };
  let desc = null;
  const bubbles = [], snow = [], plankton = [], sparks = [];
  let visible = new Set();
  const api = { onDepth: null, onZone: null };

  const ay = () => anchor.y * H;
  const rowM = y => camM + (y - ay()) / PXM;              // world depth at a screen row
  const yOf = m => ay() + (m - camM) * PXM;               // screen row of a world depth
  const layerM = (y, f) => (y - ay()) / PXM + camM * f;   // parallax layer coordinate

  function resize(w, h, px) {
    W = w; H = h; PX = px; PXM = Math.max(.35, H * .0032); // 100 m ≈ a third of the screen
    snow.length = 0; plankton.length = 0; bubbles.length = 0;
    for (let i = 0; i < W * H / 520; i++) snow.push({ m: rowM(Math.random() * H), x: Math.random() * W, a: .15 + Math.random() * .3, v: .6 + Math.random() * 1.2 });
    for (let i = 0; i < 120; i++) plankton.push({ m: rowM(Math.random() * H), x: Math.random() * W, ph: Math.random() * 6, sp: .7 + Math.random() * 1.5 });
  }

  // ---------- public control ----------
  function place(m) { if (desc) return; diverM = camM = clamp(m, 0, MAX_PIP); speed = camVel = 0; angle = 0; }
  const DUR = { drifter: 1.6, scuttler: 2.0, glimmer: 2.3, lantern: 2.9, leviathan: 3.3, fallen: 4.2 };
  function descend(to, tier = "drifter") {
    to = clamp(to, 0, MAX_PIP);
    return new Promise(resolve => {
      if (desc) { desc.resolve(); desc = null; }
      if (REDUCED || to <= diverM) { place(to); api.onDepth && api.onDepth(diverM); return resolve(); }
      const dist = to - diverM;
      desc = { from: diverM, to, t0: t, dur: (DUR[tier] || 1.8) + Math.min(1.2, dist / 2500), tier, resolve, emitted: 0 };
      for (let i = 0; i < 10; i++) addBubble(diverScreen().x + rnd(-4, 4), diverScreen().y + rnd(-3, 3), 6 + Math.random() * 6); // push-off puff
    });
  }
  /** Player is in a hurry: finish the current descent quickly but still visibly (no teleport). */
  function hurry() { if (!desc) return; const left = desc.to - diverM; desc.from = diverM; desc.t0 = t; desc.dur = clamp(.35 + left / 4000, .35, .7); }
  function setAnchor(x, y, instant) { anchorTo = { x, y }; if (instant) anchor = { x, y }; }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

  function diverScreen() {
    const bob = desc ? 0 : Math.sin(t * 1.7) * 1.6;
    return { x: anchor.x * W + Math.sin(t * .5) * (desc ? 0 : 2), y: yOf(diverM) + bob };
  }
  function addBubble(x, y, v, size) { bubbles.push({ m: rowM(y), x, v, s: size ?? (Math.random() < .6 ? 0 : Math.random() < .7 ? 1 : 2), ph: Math.random() * 6 }); }
  function spark(x, y, vx, vy, color, life) { sparks.push({ x, y, vx, vy, color, life, max: life }); }

  // ---------- simulation ----------
  function update(sec) {
    const prevCam = camM;
    if (desc) {
      const p = clamp((t - desc.t0) / desc.dur, 0, 1), prev = diverM;
      diverM = lerp(desc.from, desc.to, ease(p));
      speed = (diverM - prev) / Math.max(sec, 1e-3);
      if (zoneAt(diverM) !== zoneAt(prev) && api.onZone) api.onZone(zoneAt(diverM));
      if (api.onDepth) api.onDepth(diverM);
      const d = diverScreen(), rate = { drifter: .25, scuttler: .45, glimmer: .6, lantern: .8, leviathan: 1, fallen: 1.3 }[desc.tier] || .3;
      desc.emitted += rate * sec * 30;
      while (desc.emitted >= 1) { desc.emitted--; addBubble(d.x + rnd(-4, 4), d.y - 16, 4 + Math.random() * 6); }
      if (desc.tier === "fallen") {
        shake = Math.max(shake, .9 * Math.sin(p * Math.PI));
        for (let k = 0; k < 3; k++) { const a = t * 6 + k * 2.1, r = 10 + 4 * Math.sin(t * 3 + k); spark(d.x + Math.cos(a) * r, d.y + Math.sin(a) * r * .6, 0, -.25, k ? "244,201,90" : "199,168,255", 26); }
      }
      if (desc.tier === "leviathan") shake = Math.max(shake, .35 * Math.sin(p * Math.PI));
      if (p >= 1) {
        const d2 = diverScreen();
        for (let i = 0; i < (desc.tier === "fallen" ? 26 : 10); i++) addBubble(d2.x + rnd(-6, 6), d2.y + rnd(-4, 4), 3 + Math.random() * 6);
        if (desc.tier === "fallen") { flash = 1; for (let k = 0; k < 70; k++) { const a = Math.random() * 6.283, s = .4 + Math.random() * 1.5; spark(d2.x, d2.y, Math.cos(a) * s, Math.sin(a) * s, k % 3 ? "244,201,90" : "199,168,255", 50 + Math.random() * 40); } }
        const r = desc.resolve; desc = null; speed = 0; r();
      }
    } else speed = 0;
    // spring camera: trails the diver while moving, settles on it when idle
    camM += (diverM - camM) * (1 - Math.exp(-(desc ? 5 : 3) * sec));
    camVel = (camM - prevCam) / Math.max(sec, 1e-3);
    const k = 1 - Math.exp(-4 * sec);
    anchor.x += (anchorTo.x - anchor.x) * k; anchor.y += (anchorTo.y - anchor.y) * k;
    angle += ((speed > 25 ? Math.PI / 2 : 0) - angle) * (1 - Math.exp(-7 * sec));   // head-down while diving
    lamp += ((diverM > 220 ? 1 : 0) - lamp) * (1 - Math.exp(-3 * sec));
    shake *= Math.exp(-3 * sec); flash *= Math.exp(-2.2 * sec);
    // idle breathing bubbles from the helmet
    if (!desc && Math.random() < sec * .9) { const d = diverScreen(); for (let i = 0; i < 1 + (Math.random() * 3 | 0); i++) addBubble(d.x + 12 + rnd(-1, 1), d.y - 12 - i * 2, 4 + Math.random() * 3, 0); }
    // world particles
    const top = rowM(-24), bot = rowM(H + 24);
    for (const b of bubbles) { b.m -= b.v * sec; b.x += Math.sin(t * 2 + b.ph) * .12; }
    for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].m < top - 40 || bubbles[i].m < 0) bubbles.splice(i, 1);
    while (bubbles.length < W / 18) bubbles.push({ m: bot + Math.random() * 40, x: Math.random() * W, v: 3 + Math.random() * 4, s: Math.random() < .7 ? 0 : 1, ph: Math.random() * 6 });
    for (const s of snow) { s.m += s.v * sec; s.x += Math.sin(t * .7 + s.m) * .02; if (s.m < top) { s.m = bot - Math.random() * 10; s.x = Math.random() * W; } else if (s.m > bot) { s.m = top + Math.random() * 10; s.x = Math.random() * W; } }
    for (const p of plankton) { if (p.m < top) { p.m = bot - Math.random() * 20; p.x = Math.random() * W; } else if (p.m > bot) { p.m = top + Math.random() * 20; p.x = Math.random() * W; } }
    for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.x += s.vx; s.y += s.vy; s.vy += .012; s.vx *= .98; s.life -= sec * 30; if (s.life <= 0) sparks.splice(i, 1); }
  }

  // ---------- world features ----------
  function rockWidth(lm, side, m) {
    const n = fbm(lm * .011, side ? 11 : 23);
    const ledge = noise(lm * .045, side ? 5 : 9) > .78 ? .07 * noise(lm * .3, 3) : 0;
    return W * (.05 + .13 * n + ledge + .24 * ramp(m, 5600, 7000));
  }
  function rockColour(m) {
    // sunlit near the surface; in the deep, rock sinks below the water's own faint glow
    const lit = sunlight(m), deep = ramp(m, 1000, 6500);
    const base = [lerp(5, 22, lit), lerp(17, 64, lit), lerp(26, 74, lit)], edge = [lerp(14, 70, lit), lerp(44, 150, lit), lerp(56, 150, lit)];
    return { base: base.map((v, i) => lerp(v, [1, 3, 6][i], deep)), edge: edge.map((v, i) => lerp(v, [7, 18, 26][i], deep)) };
  }

  // creatures live in 30 m buckets; everything is derived from the bucket number, so the
  // same depth always shows the same scenery (no storage, no pop-in on revisits)
  const BUCKET = 30;
  function creaturesAt(b) {
    const out = [], m0 = b * BUCKET, r = k => h2(b, k);
    if (m0 < 0) return out;
    const m = m0 + r(1) * BUCKET, x = r(2), dir = r(3) < .5 ? -1 : 1;
    if (m < 230) {
      if (r(4) < .5) out.push({ kind: "school", m, x, dir, sprite: ["fish", "tang", "wrasse", "clown"][(r(5) * 4) | 0], n: 3 + ((r(6) * 4) | 0), sp: 4 + r(7) * 5 });
      if (r(8) < .14) out.push({ kind: "seahorse", m: m + 8, x: r(9) < .5 ? .14 : .84, dir });
      if (r(10) < .12) out.push({ kind: "crab", m: m + 4, x: r(11) < .5 ? .1 : .86, dir });
    } else if (m < 1050) {
      if (r(4) < .35) out.push({ kind: "lanternfish", m, x, dir, n: 14 + ((r(5) * 12) | 0), sp: 3 + r(6) * 3 });
      if (r(7) < .2) out.push({ kind: "jelly", m: m + 10, x: .15 + r(8) * .7, dir, glow: m > 700 });
      if (m > 300 && m < 950 && r(9) < .07) out.push({ kind: "manta", m: m + 5, x, dir, sp: 5 });
    } else if (m < 4000) {
      if (r(4) < .28) out.push({ kind: "jelly", m, x: .12 + r(5) * .76, dir, glow: true });
      if (r(6) < .12) out.push({ kind: "siphonophore", m: m + 6, x, dir, sp: 1.5 });
      if (r(7) < .07) out.push({ kind: "angler", m: m + 12, x, dir, sp: 2.5 });
    } else if (m < 6000) {
      if (r(4) < .16) out.push({ kind: "angler", m, x, dir, sp: 2 });
      if (r(6) < .1) out.push({ kind: "vent", m: m + 10, x: r(7) < .5 ? 0 : 1 });
      if (r(8) < .1) out.push({ kind: "jelly", m: m + 4, x: .2 + r(9) * .6, dir, glow: true });
    } else if (m < FLOOR_M) {
      if (r(4) < .25) out.push({ kind: "amphipods", m, x, dir, n: 4 + ((r(5) * 4) | 0), sp: 2 });
      if (r(6) < .16) out.push({ kind: "snailfish", m: m + 8, x, dir, sp: 1.5 });
    }
    if (b === Math.floor(2350 / BUCKET)) out.push({ kind: "kraken", m: 2350, x: .62 });
    return out;
  }
  const wrapX = (x0, sp, dir) => { const span = W + 60; return ((((x0 * W + dir * sp * t) % span) + span) % span) - 30; };

  function sprite(ctx, key, x, y, flip, alpha = 1, scale = 1) {
    const c = typeof key === "string" ? spriteCanvas(key) : key;
    ctx.save(); ctx.globalAlpha *= alpha;
    ctx.translate(Math.round(x), Math.round(y));
    if (flip) { ctx.translate(c.width * scale, 0); ctx.scale(-scale, scale); } else ctx.scale(scale, scale);
    ctx.drawImage(c, 0, 0); ctx.restore();
  }
  function halo(ctx, x, y, r, c, a) {
    if (a <= .003) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function drawCreature(ctx, c, phase) {
    const y = yOf(c.m);
    if (y < -60 || y > H + 60) return;
    visible.add(c.kind);
    const flip = c.dir < 0;
    switch (c.kind) {
      case "school": if (phase) return;
        for (let i = 0; i < c.n; i++) { const x = wrapX(c.x, c.sp, c.dir) + (i % 3) * 13 * -c.dir + i * 3, yy = y + ((i * 7) % 11) - 5 + Math.sin(t * 2 + i) * 1.5; sprite(ctx, c.sprite, x, yy, flip, .95, .7); }
        return;
      case "seahorse": if (!phase) sprite(ctx, "seahorse", c.x * W, y + Math.sin(t * 1.3) * 2, c.x > .5); return;
      case "crab": if (!phase) sprite(ctx, "crab", c.x * W + Math.sin(t * .8) * 3, y, false, 1, .8); return;
      case "lanternfish": {
        const cx = wrapX(c.x, c.sp, c.dir);
        for (let i = 0; i < c.n; i++) { const px = Math.round(cx + ((i * 37) % 30) - 15 + Math.sin(t * 1.3 + i) * 1.5), py = Math.round(y + ((i * 13) % 12) - 6);
          if (!phase) { ctx.fillStyle = "rgba(150,180,200,.7)"; ctx.fillRect(px, py, 3, 1); }
          else { ctx.fillStyle = `rgba(120,255,240,${.5 + .5 * Math.sin(t * 3 + i)})`; ctx.fillRect(px + (flip ? -1 : 3), py, 1, 1); } }
        return; }
      case "jelly": { const x = c.x * W + Math.sin(t * .5 + c.m) * 5, yy = y + Math.sin(t * .9 + c.m) * 3, p = .55 + .45 * Math.sin(t * 1.6 + c.m);
        if (!phase) sprite(ctx, "jelly", x, yy, false, c.glow ? .55 : .75);
        else if (c.glow) { halo(ctx, x + 7, yy + 5, 14, "84,214,208", .3 * p); sprite(ctx, "jelly", x, yy, false, .35 * p); }
        return; }
      case "manta": if (!phase) { const x = wrapX(c.x, c.sp, c.dir); sprite(ctx, "manta", x, y + Math.sin(t * .8) * 3, flip, .9, 2); } return;
      case "siphonophore": if (phase) { const x0 = wrapX(c.x, c.sp, c.dir);
        for (let i = 0; i < 26; i++) { const px = x0 + i * 2 * -c.dir, py = y + Math.sin(t * 1.4 + i * .35) * 4; ctx.fillStyle = `rgba(${i % 4 ? "120,200,255" : "200,140,255"},${.45 + .4 * Math.sin(t * 2 + i)})`; ctx.fillRect(Math.round(px), Math.round(py), 1, 1); } }
        return;
      case "angler": { const x = wrapX(c.x, c.sp, c.dir), yy = y + Math.sin(t * .7 + c.m) * 2, lx = flip ? x + 1 : x + 14;
        if (!phase) sprite(ctx, "angler", x, yy, flip, .9);
        else { halo(ctx, lx, yy, 12 + 3 * Math.sin(t * 4), "246,255,176", .55); ctx.fillStyle = "#fbffd8"; ctx.fillRect(Math.round(lx), Math.round(yy), 1, 1); }
        return; }
      case "vent": { const side = c.x, wx = side ? W - rockWidth(c.m, 1, c.m) : rockWidth(c.m, 0, c.m);
        if (phase) { halo(ctx, wx, y, 16, "255,120,60", .35 + .1 * Math.sin(t * 3));
          for (let i = 0; i < 14; i++) { const py = y - i * 2 - ((t * 12) % 2), px = wx + (side ? -1 : 1) * (2 + Math.sin(t * 2 + i * .7) * (1 + i * .25)); ctx.fillStyle = `rgba(255,${150 - i * 6},${80 - i * 4},${.5 - i * .03})`; ctx.fillRect(Math.round(px), Math.round(py), 2, 1); } }
        return; }
      case "amphipods": if (!phase) { const x0 = wrapX(c.x, c.sp, c.dir); for (let i = 0; i < c.n; i++) sprite(ctx, "krill", x0 + i * 9, y + ((i * 5) % 7), flip, .55, .7); } return;
      case "snailfish": if (!phase) sprite(ctx, snailfish, wrapX(c.x, c.sp, c.dir), y + Math.sin(t + c.m) * 2, !flip, .8); return;
      case "kraken": {
        const cx = c.x * W, s = Math.max(14, H * .14);
        if (!phase) {
          ctx.fillStyle = "#081e2b";
          for (let i = 0; i < 8; i++) { const a = i / 7 - .5; let x = cx + a * s * 1.3, yy = y + s * .65;
            for (let k = 0; k < 26; k++) { const f = k / 26; x += a * 2.4 + Math.sin(t * .9 + i * 1.3 + k * .33) * 1.1 * f; yy += s * .075; ctx.beginPath(); ctx.arc(Math.round(x), Math.round(yy), Math.max(.7, s * .24 * (1 - f)), 0, 7); ctx.fill(); } }
          ctx.beginPath(); ctx.ellipse(cx, y, s * .82, s * 1.05, 0, 0, 7); ctx.fill();
        } else for (const ex of [cx - s * .36, cx + s * .28]) { halo(ctx, ex + 1, y + s * .42, 6, "84,214,208", .45); if ((t % 6) > .15) { ctx.fillStyle = "#b6fff8"; ctx.fillRect(Math.round(ex), Math.round(y + s * .42), 2, 1); } }
        return; }
    }
  }

  function foreground(ctx, phase) {
    // big plants and rocks hugging the screen edges, passing faster than everything else
    const f = 1.4, FB = 24, l0 = layerM(-40, f), l1 = layerM(H + 40, f);
    for (let b = Math.floor(l0 / FB); b <= Math.floor(l1 / FB); b++) {
      if (h2(b, 91) > .45) continue;
      const lm = b * FB + h2(b, 92) * FB, m = lm / f;      // approximate world depth for styling
      if (m < -5) continue;
      const y = ay() + (lm - camM * f) * PXM, side = h2(b, 93) < .5 ? 0 : 1, x = side ? W - 1 : 0, dir = side ? -1 : 1;
      if (m < 260) {               // kelp + coral
        if (!phase) { const len = 22 + h2(b, 94) * 30;
          for (let k = 0; k < len; k++) { const px = x + dir * (3 + Math.sin(t * 1.1 + k * .18 + b) * k * .12 + h2(b, 95) * 6); ctx.fillStyle = k % 6 === 0 ? "#3f9a5a" : "#24704a"; ctx.fillRect(Math.round(px), Math.round(y - k), 2, 1); }
          const cols = [["#7d5cc8", "#a889f0"], ["#2fa59a", "#5fe0d0"], ["#b4467e", "#ec7fb2"]][(h2(b, 96) * 3) | 0];
          for (let s = 0; s < 4; s++) { let px = x + dir * (4 + s * 3), py = y + 4; for (let k = 0; k < 10 + s * 2; k++) { ctx.fillStyle = k > 7 ? cols[1] : cols[0]; ctx.fillRect(Math.round(px), Math.round(py), 1, 1); py--; px += dir * (.3 + Math.sin(k + s) * .4); } } }
      } else if (m < 1200) {        // sponges and sea fans in the dim water
        if (!phase) { ctx.fillStyle = "rgba(60,70,110,.85)"; for (let k = 0; k < 16; k++) ctx.fillRect(x + dir * (2 + (k % 4) * 2) - (side ? 2 : 0), Math.round(y - k), 2, 1); }
      } else {                      // glowing sea pens in the dark
        if (!phase) { ctx.fillStyle = "#0b1a22"; for (let k = 0; k < 18; k++) ctx.fillRect(x + dir * 4, Math.round(y - k), 1, 1); }
        else for (let k = 5; k < 18; k += 3) { const a = .25 + .3 * Math.sin(t * 2 + k + b); ctx.fillStyle = `rgba(150,255,200,${a})`; ctx.fillRect(x + dir * 4, Math.round(y - k), 1, 1); }
      }
    }
  }

  // ---------- render ----------
  function draw(ctx, dt) {
    const sec = (REDUCED ? 0 : dt * .033); t += sec;
    update(sec);
    visible = new Set();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (shake > .02) ctx.translate(Math.round((Math.random() - .5) * 4 * shake), Math.round((Math.random() - .5) * 4 * shake));
    const camLook = clamp(camM, 0, FLOOR_M);

    // 1. sky + water, coloured by the depth of each row
    for (let y = -2; y < H + 2; y += 2) {
      const m = rowM(y);
      if (m < 0) { const h = clamp(-m / 70, 0, 1); ctx.fillStyle = rgba([lerp(28, 9, h), lerp(88, 24, h), lerp(100, 38, h)]); }
      else ctx.fillStyle = rgba(water(m));
      ctx.fillRect(0, y, W, 2);
    }
    const sy = yOf(0);
    if (sy > 0) {                   // sky details + surface
      visible.add("surface");
      for (let i = 0; i < 5; i++) { const cy = yOf(-18 - i * 9), cx = ((h2(i, 7) * W + t * 2) % (W + 40)) - 20; ctx.fillStyle = "rgba(120,190,200,.25)"; ctx.fillRect(Math.round(cx), Math.round(cy), 14 + i * 3, 2); ctx.fillRect(Math.round(cx) + 3, Math.round(cy) - 1, 8, 1); }
      if (sy < H + 4) {
        ctx.fillStyle = "rgba(210,250,245,.55)"; ctx.fillRect(0, Math.round(sy), W, 1);
        for (let x = 0; x < W; x++) { const v = Math.sin(x * .21 + t * 1.6) + Math.sin(x * .09 - t * 1.1) * .8; if (v > .8) { ctx.fillStyle = "rgba(220,255,252,.6)"; ctx.fillRect(x, Math.round(sy) + (v > 1.3 ? 1 : 2), 2, 1); } }
      }
    }
    // 2. sunlight rays from the surface, fading out through the twilight zone
    const sun = sunlight(camLook);
    if (sun > .02) {
      visible.add("sunrays");
      const ox = W * .58, oy = sy - H * .25;
      for (let i = 0; i < 7; i++) {
        const ang = (i - 3) * .13 + Math.sin(t * .25 + i) * .025, wd = .025 + (i % 3) * .012, len = H * 1.6, a = (.06 + .035 * Math.sin(t * .6 + i * 1.7)) * sun;
        const g = ctx.createLinearGradient(0, Math.max(oy, -H), 0, Math.max(oy, -H) + len); g.addColorStop(0, `rgba(200,250,245,${a + .03 * sun})`); g.addColorStop(1, "rgba(200,250,245,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.sin(ang - wd) * len, oy + Math.cos(ang - wd) * len); ctx.lineTo(ox + Math.sin(ang + wd) * len, oy + Math.cos(ang + wd) * len); ctx.fill();
      }
    }
    // 3. far cliffs (0.35×)
    for (let y = -2; y < H + 2; y += 2) {
      const m = rowM(y); if (m < -40) continue;
      const lm = layerM(y, .35), wc = water(Math.max(0, m)), c = [wc[0] * .62, wc[1] * .66, wc[2] * .72];
      const wl = W * (.12 + .2 * fbm(lm * .006, 41) + .2 * ramp(m, 5200, 7000)), wr = W * (.1 + .2 * fbm(lm * .006, 53) + .2 * ramp(m, 5200, 7000));
      ctx.fillStyle = rgba(c); ctx.fillRect(0, y, Math.round(wl), 2); ctx.fillRect(W - Math.round(wr), y, Math.round(wr), 2);
    }
    // 4. creatures behind the rock walls' edges
    const b0 = Math.floor(rowM(-60) / BUCKET), b1 = Math.floor(rowM(H + 60) / BUCKET), crit = [];
    for (let b = b0; b <= b1; b++) crit.push(...creaturesAt(b));
    for (const c of crit) if (c.kind === "kraken") drawCreature(ctx, c, 0);
    // 5. mid rocks (0.7×) with lit inner edges
    for (let y = -2; y < H + 2; y += 2) {
      const m = rowM(y); if (m < -25) continue;
      const lm = layerM(y, .7), rc = rockColour(Math.max(0, m));
      const wl = Math.round(rockWidth(lm, 0, m)), wr = Math.round(rockWidth(lm, 1, m));
      ctx.fillStyle = rgba(rc.base); ctx.fillRect(0, y, wl, 2); ctx.fillRect(W - wr, y, wr, 2);
      ctx.fillStyle = rgba(rc.edge); ctx.fillRect(wl - 1, y, 1, 2); ctx.fillRect(W - wr, y, 1, 2);
    }
    // trench floor
    const fy = yOf(FLOOR_M);
    if (fy < H + 2) {
      visible.add("trench-floor");
      for (let x = 0; x < W; x += 2) { const top = Math.round(fy - fbm(x * .05, 77) * 8); ctx.fillStyle = "#0b0e15"; ctx.fillRect(x, top, 2, H - top + 4); ctx.fillStyle = "#2e3749"; ctx.fillRect(x, top, 2, 1); if (h2(x, 78) < .08) { ctx.fillStyle = "#4a5468"; ctx.fillRect(x, top + 2 + ((h2(x, 79) * 6) | 0), 1, 1); } }
    }
    for (const c of crit) if (c.kind !== "kraken") drawCreature(ctx, c, 0);
    foreground(ctx, 0);

    // 6. darkness closes in; Pip's headlamp keeps a pool of light around them
    const dark = darkness(camLook), d = diverScreen();
    if (dark > .01) {
      const R = Math.min(W, H) * (.38 + .16 * lamp);
      const g = ctx.createRadialGradient(d.x, d.y, 2, d.x, d.y, R);
      g.addColorStop(0, `rgba(1,4,9,${dark * (1 - .92 * lamp)})`); g.addColorStop(.55, `rgba(1,4,9,${dark * (1 - .4 * lamp)})`); g.addColorStop(1, `rgba(1,4,9,${dark})`);
      ctx.fillStyle = g; ctx.fillRect(-4, -4, W + 8, H + 8);
    }
    // 7. light that lives in the dark
    for (const c of crit) drawCreature(ctx, c, 1);
    foreground(ctx, 1);
    const glowK = ramp(camLook, 600, 1600);
    if (glowK > .01) { visible.add("bioluminescence");
      for (const p of plankton) { const y = yOf(p.m); const a = Math.min(1, (.35 + .55 * (.5 + .5 * Math.sin(t * p.sp + p.ph))) * glowK);
        ctx.fillStyle = `rgba(84,214,208,${a * .35})`; ctx.fillRect(Math.round(p.x) - 1, Math.round(y), 3, 1); ctx.fillRect(Math.round(p.x), Math.round(y) - 1, 1, 3);
        ctx.fillStyle = `rgba(190,255,250,${a})`; ctx.fillRect(Math.round(p.x), Math.round(y), 1, 1); } }
    // marine snow: lit near the lamp in the deep, streaks when the camera moves fast
    const streak = clamp(Math.abs(camVel) * PXM * .045, 1, 16), deepK = ramp(camLook, 600, 2000);
    for (const s of snow) { const y = yOf(s.m), dist = Math.hypot(s.x - d.x, y - d.y), lit = lerp(1, clamp(1.2 - dist / (Math.min(W, H) * .45), .12, 1), deepK);
      ctx.fillStyle = `rgba(216,233,231,${Math.min(.85, s.a * (1 + 1.4 * ramp(camLook, 1000, 5000)) * lit)})`; ctx.fillRect(Math.round(s.x), Math.round(y), 1, Math.round(streak)); }
    // bubbles (world-anchored, so they stream upward past a descending diver)
    for (const b of bubbles) { const y = yOf(b.m), x = Math.round(b.x), yy = Math.round(y);
      if (yy < -8 || yy > H + 8) continue;
      ctx.fillStyle = "rgba(170,240,236,.7)";
      if (b.s === 0) ctx.fillRect(x, yy, 1, 1);
      else if (b.s === 1) { ctx.fillRect(x, yy - 1, 1, 1); ctx.fillRect(x - 1, yy, 1, 1); ctx.fillRect(x + 1, yy, 1, 1); ctx.fillRect(x, yy + 1, 1, 1); }
      else { ctx.fillRect(x - 1, yy - 2, 2, 1); ctx.fillRect(x - 1, yy + 1, 2, 1); ctx.fillRect(x - 2, yy - 1, 1, 2); ctx.fillRect(x + 1, yy - 1, 1, 2); ctx.fillStyle = "#fff"; ctx.fillRect(x, yy - 1, 1, 1); } }

    // 8. escorts for rare descents
    if (desc) {
      const p = clamp((t - desc.t0) / desc.dur, 0, 1);
      if (desc.tier === "lantern") { visible.add("escort-angler"); const ex = d.x + 16, ey = d.y + 6 + Math.sin(t * 3) * 2; halo(ctx, ex + 14, ey, 18, "246,255,176", .5); sprite(ctx, "angler", ex, ey, false); }
      if (desc.tier === "leviathan") { visible.add("escort-manta"); const ex = d.x - 20 + Math.sin(t * 1.2) * 8, ey = d.y + 16; halo(ctx, ex + 20, ey + 10, 34, "122,168,255", .35); sprite(ctx, "manta", ex, ey, false, .95, 2); }
      if (desc.tier === "fallen") { visible.add("escort-star"); const sx2 = d.x + Math.sin(t * 2) * 6, sy2 = d.y + 26 + Math.sin(t * 3) * 2;
        halo(ctx, sx2, sy2, 16, "244,201,90", .7); ctx.fillStyle = "#fff6d6"; ctx.fillRect(Math.round(sx2) - 1, Math.round(sy2) - 1, 3, 3);
        if (Math.random() < .8) spark(sx2, sy2, (Math.random() - .5) * .3, -.4, "244,201,90", 30); }
      if (desc.tier === "scuttler" || desc.tier === "glimmer") halo(ctx, d.x, d.y, 14, "84,214,208", .18 * Math.sin(p * Math.PI));
    }

    // 9. the explorer
    visible.add("diver");
    const fr = diverFrames[Math.floor(t * (desc ? 12 : 4)) % 4];
    if (lamp > .05) {              // headlamp beam points where Pip faces
      const lx = d.x + Math.cos(angle) * 12, ly = d.y + Math.sin(angle) * 12, len = 44 + 30 * darkness(camLook);
      const g = ctx.createLinearGradient(lx, ly, lx + Math.cos(angle) * len, ly + Math.sin(angle) * len);
      g.addColorStop(0, `rgba(255,250,210,${.22 * lamp})`); g.addColorStop(1, "rgba(255,250,210,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(lx, ly);
      ctx.lineTo(lx + Math.cos(angle - .35) * len, ly + Math.sin(angle - .35) * len); ctx.lineTo(lx + Math.cos(angle + .35) * len, ly + Math.sin(angle + .35) * len); ctx.fill();
    }
    halo(ctx, d.x + Math.cos(angle) * 10, d.y + Math.sin(angle) * 10, 12, "84,214,208", .25 + .2 * darkness(camLook));
    ctx.save(); ctx.translate(Math.round(d.x), Math.round(d.y)); ctx.rotate(Math.round(angle / (Math.PI / 8)) * (Math.PI / 8)); ctx.scale(DS, DS); ctx.drawImage(fr, -10, -6); ctx.restore();

    // 10. sparks + arrival flash
    for (const s of sparks) { ctx.fillStyle = `rgba(${s.color},${s.life / s.max})`; ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1); }
    if (flash > .02) { ctx.strokeStyle = `rgba(244,201,90,${flash})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(d.x, d.y, (1 - flash) * W * .5 + 4, 0, 7); ctx.stroke(); halo(ctx, d.x, d.y, W * .4, "244,201,90", .25 * flash); }
    ctx.restore();
  }

  function burstAt(x, y) { for (let i = 0; i < 18; i++) addBubble(x + rnd(-12, 12), y + rnd(-3, 3), 5 + Math.random() * 8, Math.random() < .3 ? 2 : 1); }

  function debug() {
    const d = diverScreen();
    return { diverM, camM, diverX: d.x / W, diverY: d.y / H, descending: !!desc, tier: desc && desc.tier, scroll: camM * PXM, pxPerMetre: PXM,
      zone: zoneAt(diverM), darkness: darkness(clamp(camM, 0, FLOOR_M)), sunlight: sunlight(camM), visible: [...visible].sort(), anchor: { ...anchor } };
  }

  return Object.assign(api, { resize, draw, place, descend, hurry, setAnchor, burstAt, debug, zoneAt });
};
