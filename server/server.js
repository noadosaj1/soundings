"use strict";
/*
 * Soundings HTTP server: JSON API + static files from /public.
 * Run locally with `npm start`; on Vercel, api/index.js uses createHandler() (static files are
 * served by Vercel from /public).
 *   PORT                (default 8765)
 *   DB_PATH             (default data/soundings.db; local file)
 *   TURSO_DATABASE_URL  (libsql://… — use a Turso database instead of the file; required on Vercel)
 *   TURSO_AUTH_TOKEN    (token for that database)
 *   TRUST_PROXY         ("1" to take the client IP from X-Forwarded-For; automatic on Vercel)
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { openDb } = require("./db");
const { createGame, GameError } = require("./game");
const { createAuth, createLimiter } = require("./auth");
const bank = require("./questions");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 8765;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "soundings.db");
const ON_VERCEL = !!process.env.VERCEL;
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || ON_VERCEL;

let game, auth;
/** Opens the database once per process (one cold start on Vercel). */
const ready = (async () => {
  const url = process.env.TURSO_DATABASE_URL;
  if (ON_VERCEL && !url) throw new Error("TURSO_DATABASE_URL is not set: Vercel has no disk, so Soundings needs a Turso database.");
  const db = await openDb(url || DB_PATH, { authToken: process.env.TURSO_AUTH_TOKEN });
  game = createGame({ db, bank });
  auth = createAuth(db, { secure: ON_VERCEL });
})();
ready.catch(e => console.error("database:", e.message));

// Abuse limits (per client IP, in memory). Generous for people, tight for scripts.
const limitWrites = createLimiter({ limit: Number(process.env.RL_WRITES) || 40, windowMs: 10_000 });
const limitReads = createLimiter({ limit: Number(process.env.RL_READS) || 120, windowMs: 10_000 });
const limitNewPlayers = createLimiter({ limit: Number(process.env.RL_PLAYERS) || 20, windowMs: 3_600_000 });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join("; "),
};

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(data);
}
const sendJson = (res, status, body, headers = {}) => send(res, status, body, { "Content-Type": "application/json", ...headers });

function clientIp(req) {
  if (TRUST_PROXY) { const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || "unknown";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 4096) { reject(new GameError(413, "too-large", "Request too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; resolve(v && typeof v === "object" ? v : {}); } catch { reject(new GameError(400, "bad-json", "Malformed request.")); } });
    req.on("error", reject);
  });
}

const ACTIONS = {
  "GET /api/state":    { fn: (pid) => game.state(pid) },
  "GET /api/dives":    { fn: (pid) => game.history(pid) },
  "POST /api/dive":    { fn: (pid, b) => game.start(pid, { mode: b.mode, topic: b.topic ?? null }), needsPlayer: "create", noSeq: true },
  "POST /api/answer":  { fn: (pid, b) => game.answer(pid, { dive: b.dive, seq: b.seq, text: typeof b.text === "string" ? b.text : "" }), needsPlayer: true },
  "POST /api/pass":    { fn: (pid, b) => game.pass(pid, { dive: b.dive, seq: b.seq }), needsPlayer: true },
  "POST /api/next":    { fn: (pid, b) => game.next(pid, { dive: b.dive, seq: b.seq }), needsPlayer: true },
  "POST /api/surface": { fn: (pid, b) => game.surface(pid, { dive: b.dive, seq: b.seq }), needsPlayer: true },
};
// GET /api/dives/<id> reviews one finished dive (own dives only)
const REVIEW = /^\/api\/dives\/(d_[a-f0-9]{18}|legacy-\d+-[A-Za-z0-9_]+)$/;

async function api(req, res, route) {
  const rm = req.method === "GET" && REVIEW.exec(route);
  const action = rm ? { fn: pid => { if (!pid) throw new GameError(404, "no-dive", "That dive was not found."); return game.review(pid, rm[1]); } }
    : ACTIONS[`${req.method} ${route}`];
  if (!action) return sendJson(res, 404, { error: "not-found" });
  const ip = clientIp(req);
  let pid = null, body = {}; const headers = {};
  try {
    try { await ready; } catch (e) { throw new GameError(503, "no-database", "The server database is not set up yet."); }
    if (!(req.method === "GET" ? limitReads(ip) : limitWrites(ip))) throw new GameError(429, "rate-limited", "Too many requests — slow down a little.");
    pid = await auth.resolve(req.headers.cookie);
    if (req.method === "POST") {
      // JSON-only + same-origin check: blocks cross-site form posts riding the cookie.
      if (!/^application\/json/.test(req.headers["content-type"] || "")) throw new GameError(415, "json-only", "JSON required.");
      const origin = req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) throw new GameError(403, "origin", "Cross-origin request refused."); }
      body = await readJson(req);
      if (!action.noSeq && !Number.isInteger(body.seq)) throw new GameError(400, "seq", "Missing sequence number.");
    }
    if (action.needsPlayer && !pid) {
      if (action.needsPlayer !== "create") throw new GameError(409, "no-session", "Start a dive first.");
      if (!limitNewPlayers(ip)) throw new GameError(429, "rate-limited", "Too many new divers from this network. Try again later.");
      const p = await auth.createPlayer(); pid = p.playerId; headers["Set-Cookie"] = p.cookie;
    }
    sendJson(res, 200, await action.fn(pid, body), headers);
  } catch (e) {
    if (!(e instanceof GameError)) { console.error(e); e = new GameError(500, "server", "Something went wrong."); }
    let state;
    if (e.status !== 429 && pid) { try { state = await game.state(pid, typeof body.dive === "string" ? body.dive : undefined); } catch { try { state = await game.state(pid); } catch {} } }
    sendJson(res, e.status, { error: e.code, message: e.message, state }, e.status === 429 ? { ...headers, "Retry-After": "10" } : headers);
  }
}

function serveStatic(req, res, route) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let rel; try { rel = decodeURIComponent(route); } catch { return send(res, 400, "Bad request"); }
  const file = path.normalize(path.join(PUBLIC, rel === "/" ? "index.html" : rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  });
}

function handler(req, res) {
  let route;
  try { route = new URL(req.url, "http://x").pathname; } catch { return send(res, 400, "Bad request"); }
  if (route.startsWith("/api/")) return api(req, res, route);
  return serveStatic(req, res, route);
}
module.exports = { handler };
if (require.main !== module) return;

const server = http.createServer(handler);
server.requestTimeout = 10_000;    // slow-body clients
server.headersTimeout = 8_000;     // slow-header clients
server.keepAliveTimeout = 5_000;

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — another Soundings server is probably running.\nStop it, or start on another port:  $env:PORT=8770; npm start   (PowerShell)`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => console.log(`Soundings listening on http://localhost:${PORT} (db: ${process.env.TURSO_DATABASE_URL ? "Turso" : DB_PATH})`));
