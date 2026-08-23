const db = require('./db');

const CHAIN = 'robinhood';
const DEFAULT_PROJECTION_VERSION = 'rh_transfer_v1';
const DEFAULT_REPLAY_VERSION = 'rh_directional_transfer_replay_v1';

function identifier(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function uint(value, label) {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(result).toString();
}

function boundedInteger(value, label, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function hash(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a 32-byte hash`);
  return result;
}

function owner(value) {
  const result = String(value ?? '').trim();
  if (!result || result.length > 128) throw new Error('owner is invalid');
  return result;
}

function runRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), status: row.status,
    projectionVersion: row.projection_version, replayVersion: row.replay_version,
    sourceFromBlock: String(row.source_from_block),
    sourceThroughBlock: String(row.source_through_block),
    sourceThroughHash: row.source_through_hash,
    rangeBlocks: Number(row.range_blocks), rangeCount: Number(row.range_count),
  });
}

function rangeRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), runId: String(row.run_id), status: row.status,
    rangeStartBlock: String(row.range_start_block), rangeEndBlock: String(row.range_end_block),
    attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner || null,
  });
}

function errorDetails(error) {
  const code = String(error?.code || 'range_failed').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(code)) throw new Error('error.code is invalid');
  return { code, message: String(error?.message || code).trim().slice(0, 500) };
}

function createRobinhoodDirectionalTransferReplayRepository(options = {}) {
  const database = options.database || db;

  async function createRun(input = {}) {
    const projectionVersion = identifier(
      input.projectionVersion ?? DEFAULT_PROJECTION_VERSION, 'projectionVersion'
    );
    const replayVersion = identifier(
      input.replayVersion ?? DEFAULT_REPLAY_VERSION, 'replayVersion'
    );
    if (!/^rh_directional_transfer_replay_v[1-9][0-9]*$/.test(replayVersion)) {
      throw new Error('replayVersion is invalid');
    }
    const sourceFromBlock = uint(input.sourceFromBlock, 'sourceFromBlock');
    const sourceThroughBlock = uint(input.sourceThroughBlock, 'sourceThroughBlock');
    if (BigInt(sourceFromBlock) > BigInt(sourceThroughBlock)) {
      throw new Error('sourceThroughBlock must not precede sourceFromBlock');
    }
    const sourceThroughHash = hash(input.sourceThroughHash, 'sourceThroughHash');
    const rangeBlocks = boundedInteger(input.rangeBlocks ?? 1000, 'rangeBlocks', 1, 5000);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'LOCK TABLE robinhood_directional_transfer_replay_runs IN SHARE ROW EXCLUSIVE MODE'
      );
      const inserted = await client.query(
        `INSERT INTO robinhood_directional_transfer_replay_runs (
           chain, projection_version, replay_version, source_from_block,
           source_through_block, source_through_hash, range_blocks
         ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7) RETURNING *`,
        [CHAIN, projectionVersion, replayVersion, sourceFromBlock,
          sourceThroughBlock, sourceThroughHash, rangeBlocks]
      );
      const run = inserted.rows[0];
      const ranges = await client.query(
        `INSERT INTO robinhood_directional_transfer_replay_ranges (
           run_id, chain, range_start_block, range_end_block
         ) SELECT $1, $2, point,
              LEAST(point + $5::bigint - 1, $4::bigint)
           FROM generate_series($3::bigint, $4::bigint, $5::bigint) point
         RETURNING id`,
        [run.id, CHAIN, sourceFromBlock, sourceThroughBlock, rangeBlocks]
      );
      await client.query(
        `UPDATE robinhood_directional_transfer_replay_runs
            SET range_count = $2, updated_at = NOW() WHERE id = $1`,
        [run.id, ranges.rowCount]
      );
      await client.query('COMMIT');
      return Object.freeze({ id: String(run.id), status: 'planned', rangeCount: ranges.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getRun(runIdValue) {
    const runId = uint(runIdValue, 'runId');
    const result = await database.query(
      `SELECT * FROM robinhood_directional_transfer_replay_runs
        WHERE id = $1::bigint AND chain = $2`, [runId, CHAIN]
    );
    return runRow(result.rows[0]);
  }

  async function startRun(runIdValue) {
    const runId = uint(runIdValue, 'runId');
    const result = await database.query(
      `UPDATE robinhood_directional_transfer_replay_runs
          SET status = 'running', started_at = NOW(), updated_at = NOW()
        WHERE id = $1::bigint AND chain = $2 AND status = 'planned' RETURNING id`,
      [runId, CHAIN]
    );
    if (!result.rowCount) throw new Error('directional replay run is not planned');
  }

  async function claimRange(input = {}) {
    const runId = uint(input.runId, 'runId');
    const leaseOwner = owner(input.owner);
    const leaseMs = boundedInteger(input.leaseMs, 'leaseMs', 5000, 1_200_000);
    const result = await database.query(
      `WITH claimable AS (
         SELECT range.id FROM robinhood_directional_transfer_replay_ranges range
         JOIN robinhood_directional_transfer_replay_runs run ON run.id = range.run_id
          WHERE range.run_id = $1::bigint AND run.status = 'running'
            AND range.status = 'pending' AND range.next_attempt_at <= NOW()
          ORDER BY range.range_start_block LIMIT 1 FOR UPDATE OF range SKIP LOCKED
       ) UPDATE robinhood_directional_transfer_replay_ranges range SET
           status = 'leased', lease_owner = $2,
           lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         FROM claimable WHERE range.id = claimable.id RETURNING range.*`,
      [runId, leaseOwner, leaseMs]
    );
    return rangeRow(result.rows[0]);
  }

  async function reclaimExpired(runIdValue) {
    const runId = uint(runIdValue, 'runId');
    const result = await database.query(
      `UPDATE robinhood_directional_transfer_replay_ranges SET
         status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
       WHERE run_id = $1::bigint AND chain = $2 AND status = 'leased'
         AND lease_until <= NOW() RETURNING id`, [runId, CHAIN]
    );
    return result.rowCount;
  }

  async function retryRange(input = {}) {
    const runId = uint(input.runId, 'runId');
    const rangeId = uint(input.rangeId, 'rangeId');
    const leaseOwner = owner(input.owner);
    const backoffMs = boundedInteger(input.backoffMs ?? 1000, 'backoffMs', 0, 3_600_000);
    const maxAttempts = boundedInteger(input.maxAttempts ?? 5, 'maxAttempts', 1, 20);
    const failure = errorDetails(input.error);
    const result = await database.query(
      `WITH retried AS (
       UPDATE robinhood_directional_transfer_replay_ranges SET
         status = CASE WHEN attempt_count >= $6 THEN 'failed' ELSE 'pending' END,
         lease_owner = NULL, lease_until = NULL,
         next_attempt_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
         last_error_code = $5, last_error_message = $7, updated_at = NOW()
       WHERE id = $1::bigint AND run_id = $2::bigint AND status = 'leased'
         AND lease_owner = $3 AND lease_until > NOW() RETURNING status
       ), failed_run AS (
         UPDATE robinhood_directional_transfer_replay_runs SET
           status = 'failed', finished_at = NOW(), updated_at = NOW()
         WHERE id = $2::bigint AND EXISTS (
           SELECT 1 FROM retried WHERE status = 'failed'
         ) RETURNING id
       ) SELECT status FROM retried`,
      [rangeId, runId, leaseOwner, backoffMs, failure.code, maxAttempts, failure.message]
    );
    if (!result.rowCount) throw new Error('directional replay range lease is stale');
    return result.rows[0].status;
  }

  async function resumeFailed(runIdValue) {
    const runId = uint(runIdValue, 'runId');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const run = await client.query(
        `SELECT status FROM robinhood_directional_transfer_replay_runs
          WHERE id = $1::bigint AND chain = $2 FOR UPDATE`, [runId, CHAIN]
      );
      if (run.rows[0]?.status !== 'failed') throw new Error('directional replay run is not failed');
      const ranges = await client.query(
        `UPDATE robinhood_directional_transfer_replay_ranges SET
           status = 'pending', lease_owner = NULL, lease_until = NULL,
           attempt_count = 0, next_attempt_at = NOW(),
           last_error_code = NULL, last_error_message = NULL,
           started_at = NULL, updated_at = NOW()
         WHERE run_id = $1::bigint AND chain = $2 AND status = 'failed' RETURNING id`,
        [runId, CHAIN]
      );
      if (!ranges.rowCount) throw new Error('failed directional replay has no failed ranges');
      await client.query(
        `UPDATE robinhood_directional_transfer_replay_runs SET
           status = 'running', finished_at = NULL, updated_at = NOW()
         WHERE id = $1::bigint AND chain = $2`, [runId, CHAIN]
      );
      await client.query('COMMIT');
      return Object.freeze({ runId, requeued: ranges.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeRange(input = {}) {
    const runId = uint(input.runId, 'runId');
    const rangeId = uint(input.rangeId, 'rangeId');
    const leaseOwner = owner(input.owner);
    const completedThroughBlock = uint(input.completedThroughBlock, 'completedThroughBlock');
    const completedThroughHash = hash(input.completedThroughHash, 'completedThroughHash');
    const stats = ['blocksScanned', 'transfersScanned', 'edgesConsidered', 'edgesWritten']
      .map((key) => uint(input[key] ?? 0, key));
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const completed = await client.query(
        `UPDATE robinhood_directional_transfer_replay_ranges SET
           status = 'completed', lease_owner = NULL, lease_until = NULL,
           blocks_scanned = $4::bigint, transfers_scanned = $5::bigint,
           edges_considered = $6::bigint, edges_written = $7::bigint,
           completed_through_block = $8::bigint, completed_through_hash = $9,
           last_error_code = NULL, last_error_message = NULL,
           completed_at = NOW(), updated_at = NOW()
         WHERE id = $1::bigint AND run_id = $2::bigint AND status = 'leased'
           AND lease_owner = $3 AND lease_until > NOW() RETURNING id`,
        [rangeId, runId, leaseOwner, ...stats, completedThroughBlock, completedThroughHash]
      );
      if (!completed.rowCount) throw new Error('directional replay range lease is stale');
      await client.query(
        `UPDATE robinhood_directional_transfer_replay_runs run SET
           status = 'completed', finished_at = NOW(), updated_at = NOW()
         WHERE run.id = $1::bigint AND run.status = 'running' AND NOT EXISTS (
           SELECT 1 FROM robinhood_directional_transfer_replay_ranges range
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
    const runId = uint(input.runId, 'runId');
    const concurrency = boundedInteger(input.concurrency ?? 1, 'concurrency', 1, 16);
    const result = await database.query(
      `SELECT run.status, run.range_count,
         COUNT(*) FILTER (WHERE range.status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE range.status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE range.status = 'leased') AS leased,
         COUNT(*) FILTER (WHERE range.status = 'failed') AS failed,
         COALESCE(SUM(range.blocks_scanned), 0)::text AS blocks_scanned,
         COALESCE(SUM(range.transfers_scanned), 0)::text AS transfers_scanned,
         COALESCE(SUM(range.edges_written), 0)::text AS edges_written,
         AVG(EXTRACT(EPOCH FROM range.completed_at - range.started_at))
           FILTER (WHERE range.status = 'completed') AS average_seconds
       FROM robinhood_directional_transfer_replay_runs run
       LEFT JOIN robinhood_directional_transfer_replay_ranges range ON range.run_id = run.id
       WHERE run.id = $1::bigint AND run.chain = $2 GROUP BY run.id`, [runId, CHAIN]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const total = Number(row.range_count);
    const completed = Number(row.completed);
    const average = row.average_seconds == null ? null : Number(row.average_seconds);
    return Object.freeze({
      status: row.status, total, completed, pending: Number(row.pending),
      leased: Number(row.leased), failed: Number(row.failed),
      blocksScanned: row.blocks_scanned, transfersScanned: row.transfers_scanned,
      edgesWritten: row.edges_written,
      progressPct: total ? Number(((completed / total) * 100).toFixed(2)) : 0,
      etaSeconds: average == null ? null
        : Math.ceil((average * Math.max(0, total - completed)) / concurrency),
    });
  }

  return Object.freeze({
    createRun, getRun, startRun, claimRange, reclaimExpired,
    retryRange, resumeFailed, completeRange, getProgress,
  });
}

module.exports = {
  DEFAULT_PROJECTION_VERSION,
  DEFAULT_REPLAY_VERSION,
  createRobinhoodDirectionalTransferReplayRepository,
};
