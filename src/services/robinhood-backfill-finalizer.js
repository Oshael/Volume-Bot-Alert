const db = require('../models/db');

const CHAIN = 'robinhood';
const LOCK_KEY = 'robinhood:backfill:market_enriched';
const BLOCKING_REASONS = new Set([
  'manifest_gap',
  'manifest_overlap',
  'manifest_blocked',
  'manifest_incomplete',
  'staging_count_mismatch',
  'dead_letter',
]);

function boundedInteger(value, label, fallback, minimum, maximum) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function count(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function frontier(row) {
  if (!row) return null;
  return {
    name: row.frontier,
    nextBlock: String(row.next_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    checkpointTimestamp: row.checkpoint_timestamp,
    lastRangeId: row.last_range_id == null ? null : String(row.last_range_id),
    version: String(row.version),
  };
}

function rangeState(row) {
  return {
    id: String(row.id),
    fromBlock: quantity(row.from_block, 'range.from_block'),
    toBlock: quantity(row.to_block, 'range.to_block'),
    status: String(row.status),
    tracked: count(row.tracked_log_count, 'range.tracked_log_count'),
    staged: count(row.staging_count, 'range.staging_count'),
    terminal: count(row.terminal_count, 'range.terminal_count'),
    blocked: count(row.blocked_count, 'range.blocked_count'),
    checkpointBlock: row.checkpoint_block == null
      ? null
      : quantity(row.checkpoint_block, 'range.checkpoint_block'),
    checkpointHash: row.checkpoint_hash,
    checkpointTimestamp: row.checkpoint_timestamp,
  };
}

function blocker(reason, range, expectedBlock) {
  return {
    reason,
    expectedBlock: expectedBlock.toString(),
    rangeId: range?.id || null,
    rangeFromBlock: range?.fromBlock?.toString() || null,
    rangeToBlock: range?.toBlock?.toString() || null,
  };
}

function classifyRange(range, cursor) {
  if (range.fromBlock > cursor) return blocker('manifest_gap', range, cursor);
  if (range.fromBlock < cursor) return blocker('manifest_overlap', range, cursor);
  if (range.status === 'blocked') return blocker('manifest_blocked', range, cursor);
  if (range.status !== 'captured') return blocker('manifest_pending', range, cursor);
  if (range.staged !== range.tracked) {
    return blocker('staging_count_mismatch', range, cursor);
  }
  if (range.blocked > 0) return blocker('dead_letter', range, cursor);
  if (range.terminal !== range.staged) return blocker('enrichment_pending', range, cursor);
  if (
    range.checkpointBlock !== range.toBlock
    || !range.checkpointHash
    || !range.checkpointTimestamp
  ) {
    return blocker('manifest_incomplete', range, cursor);
  }
  return null;
}

function planAdvancement(input = {}) {
  const initial = quantity(input.nextBlock, 'nextBlock');
  const scanNext = quantity(input.marketScanNextBlock, 'marketScanNextBlock');
  let cursor = initial;
  let lastRange = null;
  let stop = null;
  const ranges = (input.ranges || []).map(rangeState);
  for (const range of ranges) {
    stop = classifyRange(range, cursor);
    if (stop) break;
    cursor = range.toBlock + 1n;
    lastRange = range;
  }
  if (!stop && cursor < scanNext && ranges.length < input.limit) {
    stop = blocker('manifest_gap', null, cursor);
  }
  const advancedBlocks = cursor - initial;
  return {
    nextBlock: cursor.toString(),
    advancedBlocks: advancedBlocks.toString(),
    advancedRanges: ranges.filter((range) => range.toBlock < cursor).length,
    caughtUp: cursor >= scanNext,
    blocker: stop,
    lastRange,
  };
}

function lag(left, right) {
  if (!left || !right) return null;
  const difference = quantity(left.nextBlock, 'frontier.nextBlock')
    - quantity(right.nextBlock, 'frontier.nextBlock');
  return Number(difference > 0n ? difference : 0n);
}

function createTelemetryState() {
  return { sampleAt: null, nextBlock: null, blocksPerSecond: null };
}

function updateRate(state, nextBlock, nowMs) {
  const next = quantity(nextBlock, 'market_enriched.nextBlock');
  if (state.sampleAt != null && nowMs > state.sampleAt && next > state.nextBlock) {
    const sample = Number(next - state.nextBlock) * 1000 / (nowMs - state.sampleAt);
    state.blocksPerSecond = state.blocksPerSecond == null
      ? sample
      : ((state.blocksPerSecond * 3) + sample) / 4;
  }
  state.sampleAt = nowMs;
  state.nextBlock = next;
}

function telemetry(state, frontiers, nowMs) {
  const discovery = frontiers.get('discovery_scan') || null;
  const market = frontiers.get('market_scan') || null;
  const enriched = frontiers.get('market_enriched') || null;
  if (enriched) updateRate(state, enriched.nextBlock, nowMs);
  const enrichmentLag = lag(market, enriched);
  return {
    frontiers: {
      discoveryScan: discovery,
      marketScan: market,
      marketEnriched: enriched,
    },
    lagBlocks: {
      discoveryToMarket: lag(discovery, market),
      marketToEnriched: enrichmentLag,
    },
    blocksPerSecond: state.blocksPerSecond,
    etaSeconds: enrichmentLag != null && state.blocksPerSecond > 0
      ? Math.ceil(enrichmentLag / state.blocksPerSecond)
      : null,
    sampledAt: new Date(nowMs).toISOString(),
  };
}

function statusFor(plan) {
  if (plan.blocker) {
    return BLOCKING_REASONS.has(plan.blocker.reason) ? 'blocked' : 'waiting';
  }
  if (plan.caughtUp) return 'caught_up';
  return plan.advancedRanges > 0 ? 'advanced' : 'waiting';
}

function createRobinhoodBackfillFinalizer(options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;
  const telemetryState = createTelemetryState();

  async function runOnce(input = {}) {
    const limit = boundedInteger(input.limit, 'limit', 100, 1, 1000);
    const statementTimeoutMs = boundedInteger(
      input.statementTimeoutMs, 'statementTimeoutMs', 15_000, 1000, 300_000
    );
    const lockTimeoutMs = boundedInteger(input.lockTimeoutMs, 'lockTimeoutMs', 5000, 100, 60_000);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
      const loaded = await client.query(
        `SELECT * FROM robinhood_backfill_watermarks
         WHERE chain = $1
         FOR UPDATE`,
        [CHAIN]
      );
      const frontiers = new Map(loaded.rows.map((row) => [row.frontier, frontier(row)]));
      let enriched = frontiers.get('market_enriched');
      if (!enriched) {
        const start = await client.query(
          `SELECT MIN(from_block) AS start_block
           FROM robinhood_backfill_ranges
           WHERE chain = $1 AND stream = 'market'`,
          [CHAIN]
        );
        if (start.rows[0]?.start_block == null) {
          await client.query('COMMIT');
          return {
            status: 'waiting',
            advancedBlocks: '0',
            advancedRanges: 0,
            blocker: null,
            ...telemetry(telemetryState, frontiers, now()),
          };
        }
        const inserted = await client.query(
          `INSERT INTO robinhood_backfill_watermarks (chain, frontier, next_block)
           VALUES ($1, 'market_enriched', $2)
           RETURNING *`,
          [CHAIN, start.rows[0].start_block]
        );
        enriched = frontier(inserted.rows[0]);
        frontiers.set('market_enriched', enriched);
      }
      const market = frontiers.get('market_scan');
      if (!market) throw new Error('market_scan watermark is missing');
      const candidates = await client.query(
        `SELECT ranges.*,
                COUNT(staging.transaction_hash)::int AS staging_count,
                COUNT(staging.transaction_hash) FILTER (
                  WHERE staging.enrichment_status IN ('completed', 'rejected')
                )::int AS terminal_count,
                COUNT(staging.transaction_hash) FILTER (
                  WHERE staging.enrichment_status = 'blocked'
                )::int AS blocked_count
         FROM robinhood_backfill_ranges ranges
         LEFT JOIN robinhood_market_log_staging staging
           ON staging.chain = ranges.chain AND staging.range_id = ranges.id
         WHERE ranges.chain = $1 AND ranges.stream = 'market'
           AND ranges.to_block >= $2
         GROUP BY ranges.id
         ORDER BY ranges.from_block, ranges.to_block
         LIMIT $3`,
        [CHAIN, enriched.nextBlock, limit]
      );
      const plan = planAdvancement({
        nextBlock: enriched.nextBlock,
        marketScanNextBlock: market.nextBlock,
        ranges: candidates.rows,
        limit,
      });
      if (plan.lastRange) {
        const updated = await client.query(
          `UPDATE robinhood_backfill_watermarks
           SET next_block = $3,
               checkpoint_block = $4,
               checkpoint_hash = $5,
               checkpoint_timestamp = $6,
               last_range_id = $7,
               version = version + 1,
               updated_at = NOW()
           WHERE chain = $1 AND frontier = 'market_enriched' AND next_block = $2
           RETURNING *`,
          [
            CHAIN, enriched.nextBlock, plan.nextBlock,
            plan.lastRange.checkpointBlock.toString(),
            plan.lastRange.checkpointHash,
            plan.lastRange.checkpointTimestamp,
            plan.lastRange.id,
          ]
        );
        if (updated.rowCount !== 1) throw new Error('market_enriched frontier changed');
        frontiers.set('market_enriched', frontier(updated.rows[0]));
      }
      await client.query('COMMIT');
      return {
        status: statusFor(plan),
        advancedBlocks: plan.advancedBlocks,
        advancedRanges: plan.advancedRanges,
        blocker: plan.blocker,
        ...telemetry(telemetryState, frontiers, now()),
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createRobinhoodBackfillFinalizer,
  __private: { planAdvancement, telemetry },
};
