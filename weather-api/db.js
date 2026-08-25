// Persists the "current" weather condition per location so it survives
// across requests (and server restarts) instead of being recomputed from
// scratch every time. Each location holds its condition for a random
// 15-120min stretch, then rolls a new one — meant to simulate weather that
// slowly drifts rather than one that's stable-per-hour-bucket or random on
// every request. Uses node:sqlite (built into Node 22+, no extra deps) —
// this is a temporary/example store, so nothing fancier than a single table
// is warranted yet.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONDITIONS } from './locations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.WEATHER_DB_PATH || join(__dirname, 'weather.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS weather_state (
    slug TEXT PRIMARY KEY,
    condition_key TEXT NOT NULL,
    temp_jitter INTEGER NOT NULL,
    wind_dir_deg INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    next_change_at TEXT NOT NULL
  )
`);

const MIN_HOLD_MS = 15 * 60 * 1000;
const MAX_HOLD_MS = 120 * 60 * 1000;
const TEMP_JITTER_OPTIONS = [-2, -1, 0, 1, 2];

const getStmt = db.prepare('SELECT * FROM weather_state WHERE slug = ?');
const upsertStmt = db.prepare(`
  INSERT INTO weather_state (slug, condition_key, temp_jitter, wind_dir_deg, updated_at, next_change_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET
    condition_key = excluded.condition_key,
    temp_jitter = excluded.temp_jitter,
    wind_dir_deg = excluded.wind_dir_deg,
    updated_at = excluded.updated_at,
    next_change_at = excluded.next_change_at
`);

function randomHoldMs() {
  return MIN_HOLD_MS + Math.floor(Math.random() * (MAX_HOLD_MS - MIN_HOLD_MS));
}

function randomConditionKey(excludeKey) {
  const choices = excludeKey
    ? CONDITIONS.filter((c) => c.key !== excludeKey)
    : CONDITIONS;
  return choices[Math.floor(Math.random() * choices.length)].key;
}

function rollState(slug, excludeKey) {
  const now = new Date();
  const state = {
    slug,
    conditionKey: randomConditionKey(excludeKey),
    tempJitter: TEMP_JITTER_OPTIONS[Math.floor(Math.random() * TEMP_JITTER_OPTIONS.length)],
    windDirDeg: Math.floor(Math.random() * 360),
    updatedAt: now.toISOString(),
    nextChangeAt: new Date(now.getTime() + randomHoldMs()).toISOString(),
  };

  upsertStmt.run(
    state.slug,
    state.conditionKey,
    state.tempJitter,
    state.windDirDeg,
    state.updatedAt,
    state.nextChangeAt,
  );

  return state;
}

// Returns the location's current state, rolling a fresh one if this is the
// first time we've seen it or its hold period has expired.
export function currentState(slug) {
  const row = getStmt.get(slug);

  if (!row) return rollState(slug, null);
  if (Date.now() >= Date.parse(row.next_change_at)) return rollState(slug, row.condition_key);

  return {
    slug: row.slug,
    conditionKey: row.condition_key,
    tempJitter: row.temp_jitter,
    windDirDeg: row.wind_dir_deg,
    updatedAt: row.updated_at,
    nextChangeAt: row.next_change_at,
  };
}
