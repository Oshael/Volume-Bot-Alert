const db = require('./db');

const CHAIN = 'robinhood';

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an instant`);
  return parsed.toISOString();
}

function owner(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 128) throw new Error('owner is invalid');
  return normalized;
}

function rangeRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), runId: String(row.run_id), status: row.status,
    rangeStart: row.range_start.toISOString(), rangeEnd: row.range_end.toISOString(),
    attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner || null,
  });
}

function runRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), status: row.status,
    sourceFrom: row.source_from.toISOString(), sourceThrough: row.source_through.toISOString(),
    rangeSeconds: Number(row.range_seconds), rangeCount: Number(row.range_count),
  });
}

function createRobinhoodFirstBuyBackfillRepository(options = {}) {
  const database = options.database || db;

  async function createRun(input = {}) {
    const sourceFrom = instant(input.sourceFrom, 'sourceFrom');
    const sourceThrough = instant(input.sourceThrough, 'sourceThrough');
    if (sourceFrom >= sourceThrough) throw new Error('sourceThrough must be after sourceFrom');
    const rangeSeconds = positiveInteger(input.rangeSeconds, 'rangeSeconds', 86_400);
    if (rangeSeconds < 60) throw new Error('rangeSeconds must be at least 60');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE robinhood_first_buy_backfill_runs IN SHARE ROW EXCLUSIVE MODE');
      const run = await client.query(
        `INSERT INTO robinhood_first_buy_backfill_runs (
           chain, source_from, source_through, range_seconds
         ) VALUES ($1, $2, $3, $4) RETURNING *`,
        [CHAIN, sourceFrom, sourceThrough, rangeSeconds]
      );
      const runId = run.rows[0].id;
      const ranges = await client.query(
        `INSERT INTO robinhood_first_buy_backfill_ranges (
           run_id, chain, range_start, range_end
         ) SELECT $1, $2, point,
                  LEAST(point + ($5::bigint * INTERVAL '1 second'), $4::timestamptz)
             FROM generate_series(
               $3::timestamptz, $4::timestamptz - INTERVAL '1 microsecond',
               $5::bigint * INTERVAL '1 second'
             ) point RETURNING id`,
        [runId, CHAIN, sourceFrom, sourceThrough, rangeSeconds]
      );
      await client.query(
        `UPDATE robinhood_first_buy_backfill_runs
            SET range_count = $2, updated_at = NOW() WHERE id = $1`,
        [runId, ranges.rowCount]
      );
      await client.query('COMMIT');
      return Object.freeze({ id: String(runId), status: 'planned', rangeCount: ranges.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getRun(runIdValue) {
    const runId = positiveInteger(runIdValue, 'runId');
    const result = await database.query(
      `SELECT id, status, source_from, source_through, range_seconds, range_count
         FROM robinhood_first_buy_backfill_runs WHERE id = $1 AND chain = $2`,
      [runId, CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function startRun(runIdValue) {
    const runId = positiveInteger(runIdValue, 'runId');
    const result = await database.query(
      `UPDATE robinhood_first_buy_backfill_runs
          SET status = 'running', started_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND chain = $2 AND status = 'planned' RETURNING id`,
      [runId, CHAIN]
    );
    if (!result.rowCount) throw new Error('first-buy backfill run is not planned');
  }

  async function resumeFailed(runIdValue) {
    const runId = positiveInteger(runIdValue, 'runId');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const run = await client.query(
        `SELECT status FROM robinhood_first_buy_backfill_runs
          WHERE id = $1 AND chain = $2 FOR UPDATE`, [runId, CHAIN]
      );
      if (run.rows[0]?.status !== 'failed') {
        throw new Error('first-buy backfill run is not failed');
      }
      const ranges = await client.query(
        `UPDATE robinhood_first_buy_backfill_ranges SET
           status = 'pending', lease_owner = NULL, lease_until = NULL,
           attempt_count = 0, next_attempt_at = NOW(),
           last_error_code = NULL, last_error_message = NULL,
           started_at = NULL, updated_at = NOW()
         WHERE run_id = $1 AND chain = $2 AND status = 'failed'
         RETURNING id`, [runId, CHAIN]
      );
      if (!ranges.rowCount) throw new Error('failed run has no failed ranges');
      await client.query(
        `UPDATE robinhood_first_buy_backfill_runs
            SET status = 'running', finished_at = NULL, updated_at = NOW()
          WHERE id = $1 AND chain = $2`, [runId, CHAIN]
      );
      await client.query('COMMIT');
      return Object.freeze({ runId: String(runId), requeued: ranges.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function claimRange(input = {}) {
    const runId = positiveInteger(input.runId, 'runId');
    const leaseOwner = owner(input.owner);
    const leaseMs = positiveInteger(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT range.id FROM robinhood_first_buy_backfill_ranges range
         INNER JOIN robinhood_first_buy_backfill_runs run ON run.id = range.run_id
          WHERE range.run_id = $1 AND run.status = 'running'
            AND range.status = 'pending' AND range.next_attempt_at <= NOW()
          ORDER BY range.range_start LIMIT 1 FOR UPDATE OF range SKIP LOCKED
       ) UPDATE robinhood_first_buy_backfill_ranges range
            SET status = 'leased', lease_owner = $2,
                lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, NOW()), updated_at = NOW()
           FROM claimable WHERE range.id = claimable.id RETURNING range.*`,
      [runId, leaseOwner, leaseMs]
    );
    return rangeRow(result.rows[0]);
  }

  async function reclaimExpired(runIdValue) {
    const runId = positiveInteger(runIdValue, 'runId');
    const result = await database.query(
      `UPDATE robinhood_first_buy_backfill_ranges
          SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
        WHERE run_id = $1 AND chain = $2 AND status = 'leased' AND lease_until <= NOW()
        RETURNING id`, [runId, CHAIN]
    );
    return result.rowCount;
  }

  async function retryRange(input = {}) {
    const runId = positiveInteger(input.runId, 'runId');
    const rangeId = positiveInteger(input.rangeId, 'rangeId');
    const leaseOwner = owner(input.owner);
    const backoffMs = nonNegativeInteger(input.backoffMs ?? 1000, 'backoffMs');
    const maxAttempts = positiveInteger(input.maxAttempts ?? 5, 'maxAttempts');
    const code = String(input.error?.code || 'range_failed').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(code)) throw new Error('error.code is invalid');
    const message = String(input.error?.message || code).trim().slice(0, 500);
    const result = await database.query(
      `WITH retried AS (
       UPDATE robinhood_first_buy_backfill_ranges SET
         status = CASE WHEN attempt_count >= $6 THEN 'failed' ELSE 'pending' END,
         lease_owner = NULL, lease_until = NULL,
         next_attempt_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
         last_error_code = $5, last_error_message = $7, updated_at = NOW()
       WHERE id = $1 AND run_id = $2 AND status = 'leased'
         AND lease_owner = $3 AND lease_until > NOW() RETURNING status
       ), failed_run AS (
         UPDATE robinhood_first_buy_backfill_runs SET
           status = 'failed', finished_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND EXISTS (SELECT 1 FROM retried WHERE status = 'failed')
         RETURNING id
       ) SELECT status FROM retried`,
      [rangeId, runId, leaseOwner, backoffMs, code, maxAttempts, message]
    );
    if (!result.rowCount) throw new Error('first-buy backfill range lease is stale');
    return result.rows[0].status;
  }

  async function completeRange(input = {}) {
    const runId = positiveInteger(input.runId, 'runId');
    const rangeId = positiveInteger(input.rangeId, 'rangeId');
    const leaseOwner = owner(input.owner);
    const values = ['rowsScanned', 'factsConsidered', 'factsWritten']
      .map((key) => nonNegativeInteger(input[key] ?? 0, key));
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const completed = await client.query(
        `UPDATE robinhood_first_buy_backfill_ranges SET
           status = 'completed', lease_owner = NULL, lease_until = NULL,
           rows_scanned = $4, facts_considered = $5, facts_written = $6,
           completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND run_id = $2 AND status = 'leased'
           AND lease_owner = $3 AND lease_until > NOW() RETURNING id`,
        [rangeId, runId, leaseOwner, ...values]
      );
      if (!completed.rowCount) throw new Error('first-buy backfill range lease is stale');
      await client.query(
        `UPDATE robinhood_first_buy_backfill_runs run
            SET status = 'completed', finished_at = NOW(), updated_at = NOW()
          WHERE run.id = $1 AND run.status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_first_buy_backfill_ranges range
               WHERE range.run_id = run.id AND range.status <> 'completed'
            )`, [runId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getProgress(input = {}) {
    const runId = positiveInteger(input.runId, 'runId');
    const concurrency = positiveInteger(input.concurrency ?? 1, 'concurrency', 64);
    const result = await database.query(
      `SELECT run.status, run.range_count,
              COUNT(*) FILTER (WHERE range.status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE range.status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE range.status = 'leased') AS leased,
              COUNT(*) FILTER (WHERE range.status = 'failed') AS failed,
              COALESCE(SUM(range.rows_scanned), 0) AS rows_scanned,
              COALESCE(SUM(range.facts_written), 0) AS facts_written,
              AVG(EXTRACT(EPOCH FROM range.completed_at - range.started_at))
                FILTER (WHERE range.status = 'completed') AS average_seconds
         FROM robinhood_first_buy_backfill_runs run
         LEFT JOIN robinhood_first_buy_backfill_ranges range ON range.run_id = run.id
        WHERE run.id = $1 AND run.chain = $2 GROUP BY run.id`, [runId, CHAIN]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const total = Number(row.range_count);
    const completed = Number(row.completed);
    const average = row.average_seconds == null ? null : Number(row.average_seconds);
    const remaining = Math.max(0, total - completed);
    return Object.freeze({
      status: row.status, total, completed, pending: Number(row.pending),
      leased: Number(row.leased), failed: Number(row.failed),
      rowsScanned: Number(row.rows_scanned), factsWritten: Number(row.facts_written),
      progressPct: total ? Number(((completed / total) * 100).toFixed(2)) : 0,
      etaSeconds: average == null ? null : Math.ceil((average * remaining) / concurrency),
    });
  }

  return Object.freeze({
    createRun, getRun, startRun, resumeFailed, claimRange, reclaimExpired,
    retryRange, completeRange, getProgress,
  });
}

module.exports = { createRobinhoodFirstBuyBackfillRepository };
