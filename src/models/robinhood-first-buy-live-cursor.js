const db = require('./db');

const CHAIN = 'robinhood';

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an instant`);
  return parsed.toISOString();
}

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function normalize(row) {
  if (!row) return null;
  return Object.freeze({
    chain: row.chain, seedRunId: String(row.seed_run_id),
    nextTime: new Date(row.next_time).toISOString(),
    sourceThrough: new Date(row.source_through).toISOString(),
    sourceNextBlock: row.source_next_block == null ? null : String(row.source_next_block),
    version: Number(row.version),
  });
}

function createRobinhoodFirstBuyLiveCursorRepository(options = {}) {
  const database = options.database || db;

  async function loadCursor() {
    const result = await database.query(
      'SELECT * FROM robinhood_first_buy_live_cursors WHERE chain = $1', [CHAIN]
    );
    return normalize(result.rows[0]);
  }

  async function initializeFromRun(runIdValue) {
    const runId = uint(runIdValue, 'seedRunId');
    await database.query(
      `INSERT INTO robinhood_first_buy_live_cursors (
         chain, seed_run_id, next_time, source_through
       ) SELECT $1::varchar(16), run.id, run.source_through, run.source_through
           FROM robinhood_first_buy_backfill_runs run
          WHERE run.id = $2 AND run.chain = $1::varchar(16) AND run.status = 'completed'
       ON CONFLICT (chain) DO NOTHING`,
      [CHAIN, runId]
    );
    const cursor = await loadCursor();
    if (!cursor) return null;
    if (cursor.seedRunId !== runId) {
      const error = new Error('first-buy LIVE cursor belongs to another seed run');
      error.code = 'first_buy_seed_mismatch';
      throw error;
    }
    return cursor;
  }

  async function advance(input = {}) {
    const nextTime = instant(input.nextTime, 'nextTime');
    const sourceThrough = instant(input.sourceThrough, 'sourceThrough');
    if (nextTime > sourceThrough) throw new Error('nextTime cannot exceed sourceThrough');
    const sourceNextBlock = uint(input.sourceNextBlock, 'sourceNextBlock');
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error('expectedVersion must be a non-negative integer');
    }
    const result = await database.query(
      `UPDATE robinhood_first_buy_live_cursors SET
         next_time = $2, source_through = GREATEST(source_through, $3::timestamptz),
         source_next_block = $4::bigint, version = version + 1, updated_at = NOW()
       WHERE chain = $1 AND version = $5
         AND next_time <= $2::timestamptz AND source_through <= $3::timestamptz
         AND (source_next_block IS NULL OR source_next_block <= $4::bigint)
       RETURNING *`,
      [CHAIN, nextTime, sourceThrough, sourceNextBlock, expectedVersion]
    );
    return normalize(result.rows[0]);
  }

  return Object.freeze({ advance, initializeFromRun, loadCursor });
}

module.exports = { createRobinhoodFirstBuyLiveCursorRepository, __private: { normalize } };
