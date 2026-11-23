"use strict";
/*
 * Identity layer. Today players are anonymous: a browser gets a random 128-bit token in an
 * HttpOnly cookie, and the database stores only SHA-256(token) -> player id, so a leaked DB
 * can't be replayed as cookies and the player id never doubles as a credential.
 *
 * Accounts are prepared but not exposed: `linkIdentity` attaches an external login
 * (provider + subject from OAuth/OIDC, email magic link, …) to an account that owns the
 * player, and `playerForIdentity` resolves it back. A login route would: verify the provider
 * → playerForIdentity() → if none, linkIdentity(current anonymous player) → issueToken().
 */
const crypto = require("node:crypto");

const COOKIE = "sid";
const TOKEN_RE = /^[a-f0-9]{32}$/;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const randomHex = bytes => crypto.randomBytes(bytes).toString("hex");

function createAuth(db, { now = () => Date.now(), secure = false } = {}) {
  const sql = {
    token:      db.prepare("SELECT player FROM auth_tokens WHERE token_hash = ?"),
    touch:      db.prepare("UPDATE auth_tokens SET last_seen = ? WHERE token_hash = ?"),
    addToken:   db.prepare("INSERT INTO auth_tokens (token_hash, player, created_at, last_seen) VALUES (?, ?, ?, ?)"),
    player:     db.prepare("SELECT id, account_id FROM players WHERE id = ?"),
    addPlayer:  db.prepare("INSERT INTO players (id, created_at) VALUES (?, ?)"),
    identity:   db.prepare("SELECT p.id AS player FROM identities i JOIN players p ON p.account_id = i.account_id WHERE i.provider = ? AND i.subject = ?"),
    addAccount: db.prepare("INSERT INTO accounts (id, created_at, display_name) VALUES (?, ?, ?)"),
    addIdent:   db.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)"),
    setAccount: db.prepare("UPDATE players SET account_id = ? WHERE id = ? AND account_id IS NULL"),
  };

  function tokenFromCookie(header) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(header || "");
    return m && TOKEN_RE.test(m[1]) ? m[1] : null;
  }

  /** Player id for a request's cookie, or null. Migrates pre-hashing cookies (token == player id). */
  async function resolve(cookieHeader) {
    const token = tokenFromCookie(cookieHeader);
    if (!token) return null;
    const h = sha256(token), t = now();
    const row = await sql.token.get(h);
    if (row) { await sql.touch.run(t, h); return row.player; }
    if (await sql.player.get(token)) { await sql.addToken.run(h, token, t, t); return token; }   // legacy cookie
    return null;
  }

  /** Create a new anonymous player plus a token; returns { playerId, cookie }. */
  async function createPlayer() {
    const id = "p_" + randomHex(12), token = randomHex(16), t = now();
    await sql.addPlayer.run(id, t);
    await sql.addToken.run(sha256(token), id, t, t);
    return { playerId: id, cookie: cookieFor(token) };
  }

  /** Issue an extra token for an existing player (e.g. after a future login). */
  async function issueToken(playerId) {
    const token = randomHex(16), t = now();
    await sql.addToken.run(sha256(token), playerId, t, t);
    return cookieFor(token);
  }

  function cookieFor(token) {
    return `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  /** Attach an external identity to the player's account (creating the account if needed). */
  async function linkIdentity(playerId, provider, subject, displayName = null) {
    if (!provider || !subject) throw new Error("provider and subject required");
    if (await sql.identity.get(provider, String(subject))) throw new Error("identity already linked");
    const p = await sql.player.get(playerId);
    if (!p) throw new Error("unknown player");
    const t = now();
    let account = p.account_id;
    if (!account) { account = "a_" + randomHex(12); await sql.addAccount.run(account, t, displayName); await sql.setAccount.run(account, playerId); }
    await sql.addIdent.run(provider, String(subject), account, t);
    return account;
  }

  async function playerForIdentity(provider, subject) {
    const row = await sql.identity.get(provider, String(subject));
    return row ? row.player : null;
  }

  return { resolve, createPlayer, issueToken, linkIdentity, playerForIdentity, tokenFromCookie };
}

/** Fixed-window rate limiter kept in memory (single process). */
function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return function allow(key) {
    const t = now(), w = hits.get(key);
    if (!w || t - w.start >= windowMs) { hits.set(key, { start: t, n: 1 }); if (hits.size > 50_000) prune(t); return true; }
    return ++w.n <= limit;
  };
  function prune(t) { for (const [k, w] of hits) if (t - w.start >= windowMs) hits.delete(k); }
}

module.exports = { createAuth, createLimiter, sha256 };
