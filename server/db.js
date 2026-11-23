"use strict";
/*
 * Database: libSQL (SQLite). Locally a file (data/soundings.db) or ":memory:"; in production a
 * Turso database (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), because serverless hosts such as Vercel
 * have no disk that survives between requests.
 *
 * The returned object keeps a prepared-statement style API, but every call is async:
 *   await db.prepare(sql).get(...args) / .all(...args) / .run(...args) -> { changes }
 *   await db.tx(async () => { ... })    statements inside run in one write transaction
 */
const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createClient } = require("@libsql/client");

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS players (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL
    );
    -- Frozen daily challenge: the question ids for a day, written the first time the day is served.
    CREATE TABLE IF NOT EXISTS daily (
      day   INTEGER PRIMARY KEY,
      qids  TEXT NOT NULL
    );
    -- One scored attempt per player per day (primary key enforces it).
    CREATE TABLE IF NOT EXISTS sessions (
      day          INTEGER NOT NULL,
      player       TEXT NOT NULL REFERENCES players(id),
      phase        TEXT NOT NULL CHECK (phase IN ('question','between','done')),
      idx          INTEGER NOT NULL,
      seq          INTEGER NOT NULL,
      score        INTEGER NOT NULL DEFAULT 0,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      PRIMARY KEY (day, player)
    );
    -- Timer state and outcome of each question for a session.
    CREATE TABLE IF NOT EXISTS rounds (
      day         INTEGER NOT NULL,
      player      TEXT NOT NULL,
      n           INTEGER NOT NULL,
      qid         TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      deadline    INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('open','accepted','passed','timeout')),
      answer_id   TEXT,
      answer_raw  TEXT,
      tier        TEXT,
      points      INTEGER NOT NULL DEFAULT 0,
      share       REAL,
      live_total  INTEGER,
      closed_at   INTEGER,
      PRIMARY KEY (day, player, n),
      FOREIGN KEY (day, player) REFERENCES sessions(day, player)
    );
    -- Every submitted answer. Unique per normalised text so a repeated guess is never re-processed.
    CREATE TABLE IF NOT EXISTS attempts (
      day       INTEGER NOT NULL,
      player    TEXT NOT NULL,
      n         INTEGER NOT NULL,
      norm      TEXT NOT NULL,
      raw       TEXT NOT NULL,
      accepted  INTEGER NOT NULL,
      at        INTEGER NOT NULL,
      PRIMARY KEY (day, player, n, norm)
    );
    -- Live response frequencies: how many players had each accepted answer counted.
    CREATE TABLE IF NOT EXISTS answer_counts (
      qid        TEXT NOT NULL,
      answer_id  TEXT NOT NULL,
      n          INTEGER NOT NULL,
      PRIMARY KEY (qid, answer_id)
    );
    -- Frozen rarity: answer_counts for each daily question, copied when the day is first served.
    -- All of that day's scoring uses this snapshot, so every player gets the same tier for the
    -- same answer no matter when they play. Today's answers only affect future days.
    CREATE TABLE IF NOT EXISTS rarity_snapshot (
      day      INTEGER NOT NULL,
      qid      TEXT NOT NULL,
      counts   TEXT NOT NULL,
      total    INTEGER NOT NULL,
      PRIMARY KEY (day, qid)
    );
    -- Browser sessions: the cookie holds a random token; only its SHA-256 is stored.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash  TEXT PRIMARY KEY,
      player      TEXT NOT NULL REFERENCES players(id),
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    -- Optional accounts (not exposed yet): an account owns one player record; identities are
    -- external logins (provider + subject, e.g. an OAuth "sub") linked to the account.
    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      display_name  TEXT
    );
    CREATE TABLE IF NOT EXISTS identities (
      provider    TEXT NOT NULL,
      subject     TEXT NOT NULL,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (provider, subject)
    );
    -- Unlimited play: every game is a dive with its own id. No daily limits.
    CREATE TABLE IF NOT EXISTS dives (
      id           TEXT PRIMARY KEY,
      player       TEXT NOT NULL REFERENCES players(id),
      mode         TEXT NOT NULL,
      topic        TEXT,
      phase        TEXT NOT NULL CHECK (phase IN ('question','between','done')),
      idx          INTEGER NOT NULL,
      seq          INTEGER NOT NULL,
      score        INTEGER NOT NULL DEFAULT 0,
      lives        INTEGER,
      qids         TEXT NOT NULL,           -- planned question order (endless: grows as it goes)
      question_ms  INTEGER NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      end_reason   TEXT                     -- complete | surfaced | out-of-air | abandoned | legacy
    );
    CREATE TABLE IF NOT EXISTS dive_rounds (
      dive        TEXT NOT NULL REFERENCES dives(id),
      n           INTEGER NOT NULL,
      qid         TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      deadline    INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('open','accepted','passed','timeout')),
      answer_id   TEXT,
      answer_raw  TEXT,
      tier        TEXT,
      points      INTEGER NOT NULL DEFAULT 0,
      share       REAL,
      live_total  INTEGER,
      closed_at   INTEGER,
      PRIMARY KEY (dive, n)
    );
    CREATE TABLE IF NOT EXISTS dive_attempts (
      dive      TEXT NOT NULL,
      n         INTEGER NOT NULL,
      norm      TEXT NOT NULL,
      raw       TEXT NOT NULL,
      accepted  INTEGER NOT NULL,
      at        INTEGER NOT NULL,
      PRIMARY KEY (dive, n, norm)
    );
    CREATE INDEX IF NOT EXISTS dives_player ON dives(player, started_at);
    CREATE INDEX IF NOT EXISTS dive_rounds_qid ON dive_rounds(qid);
    CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player, day);
    CREATE INDEX IF NOT EXISTS rounds_player ON rounds(player, status);
`;

const MIGRATE_LEGACY = `
  INSERT OR IGNORE INTO dives (id, player, mode, topic, phase, idx, seq, score, lives, qids, question_ms, started_at, finished_at, end_reason)
    SELECT 'legacy-' || day || '-' || player, player, 'daily', NULL, 'done', idx, seq, score, NULL,
           (SELECT json_group_array(qid) FROM (SELECT qid FROM rounds r WHERE r.day = s.day AND r.player = s.player ORDER BY n)),
           25000, started_at, finished_at, 'legacy'
    FROM sessions s WHERE phase = 'done';
  INSERT OR IGNORE INTO dive_rounds (dive, n, qid, started_at, deadline, status, answer_id, answer_raw, tier, points, share, live_total, closed_at)
    SELECT 'legacy-' || r.day || '-' || r.player, n, qid, r.started_at, deadline, status, answer_id, answer_raw, tier, points, share, live_total, closed_at
    FROM rounds r JOIN sessions s ON s.day = r.day AND s.player = r.player WHERE s.phase = 'done';
`;

/**
 * Opens (and migrates) the Soundings database.
 * target: ":memory:", a file path, or a libsql:// / https:// URL (Turso; pass authToken).
 */
async function openDb(target = ":memory:", { authToken } = {}) {
  const remote = /^(libsql|https?|wss?):/.test(target);
  let url = target;
  if (!remote && target !== ":memory:") {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    url = "file:" + target.split(path.sep).join("/");
  }
  const client = createClient({ url, authToken });

  // Statements inside db.tx() run on the transaction; everything else on the client.
  // One write transaction at a time per process, so concurrent requests queue instead of
  // failing with SQLITE_BUSY on a local file (Turso serialises writes across instances itself).
  // Queries outside a transaction wait for an open one: a ":memory:" database has one connection.
  let queue = Promise.resolve();
  const scope = new AsyncLocalStorage();
  async function exec(sql, args) {
    const t = scope.getStore();
    if (!t) await queue;
    return (t || client).execute({ sql, args: args.map(a => (a === undefined ? null : a)) });
  }

  async function tx(fn) {
    const prev = queue; let release;
    queue = new Promise(r => (release = r));
    await prev;
    const t = await client.transaction("write");
    try {
      const result = await scope.run(t, fn);
      await t.commit();
      return result;
    } catch (e) {
      await t.rollback().catch(() => {});
      throw e;
    } finally {
      t.close();
      release();
    }
  }

  const db = {
    remote,
    prepare: sql => ({
      get: async (...args) => (await exec(sql, args)).rows[0],
      all: async (...args) => (await exec(sql, args)).rows,
      run: async (...args) => ({ changes: (await exec(sql, args)).rowsAffected }),
    }),
    exec: sql => client.executeMultiple(sql),
    tx,
    close: () => client.close(),
  };

  if (!remote && target !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
  if (!remote) await client.execute("PRAGMA foreign_keys = ON");
  // Schema work runs once per database, not on every serverless cold start: a single query
  // tells whether this database is already at SCHEMA_VERSION.
  if ((await schemaVersion(client)) < SCHEMA_VERSION) {
    await db.exec(SCHEMA);
    // additive migration for databases created before accounts existed
    const cols = (await db.prepare("PRAGMA table_info(players)").all()).map(c => c.name);
    if (!cols.includes("account_id")) await db.exec("ALTER TABLE players ADD COLUMN account_id TEXT REFERENCES accounts(id)");
    // one-time carry-over of finished daily dives into the unlimited dive history
    await db.exec(MIGRATE_LEGACY);
    await db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '${SCHEMA_VERSION}');`);
  }
  return db;
}

const SCHEMA_VERSION = 1;   // bump when SCHEMA or the migrations above change
async function schemaVersion(client) {
  try { return Number((await client.execute("SELECT v FROM meta WHERE k = 'schema'")).rows[0]?.v) || 0; }
  catch { return 0; }   // no meta table yet
}

module.exports = { openDb };
