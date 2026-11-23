"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/** Opens (and migrates) the Soundings database. One file, one process. */
function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
  `);
  // additive migration for databases created before accounts existed
  const cols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
  if (!cols.includes("account_id")) db.exec("ALTER TABLE players ADD COLUMN account_id TEXT REFERENCES accounts(id)");
  // one-time carry-over of finished daily dives into the unlimited dive history
  db.exec(`
    INSERT OR IGNORE INTO dives (id, player, mode, topic, phase, idx, seq, score, lives, qids, question_ms, started_at, finished_at, end_reason)
      SELECT 'legacy-' || day || '-' || player, player, 'daily', NULL, 'done', idx, seq, score, NULL,
             (SELECT json_group_array(qid) FROM (SELECT qid FROM rounds r WHERE r.day = s.day AND r.player = s.player ORDER BY n)),
             25000, started_at, finished_at, 'legacy'
      FROM sessions s WHERE phase = 'done';
    INSERT OR IGNORE INTO dive_rounds (dive, n, qid, started_at, deadline, status, answer_id, answer_raw, tier, points, share, live_total, closed_at)
      SELECT 'legacy-' || r.day || '-' || r.player, n, qid, r.started_at, deadline, status, answer_id, answer_raw, tier, points, share, live_total, closed_at
      FROM rounds r JOIN sessions s ON s.day = r.day AND s.player = r.player WHERE s.phase = 'done';
  `);
  return db;
}

module.exports = { openDb };
