/**
 * Robinhood wallet-swap attribution cursor repository (stage 91).
 *
 * Read/advance the independent `seed` and `live` progress watermarks so the
 * attribution work resumes without rescanning blocks. Advancement uses
 * optimistic concurrency on `version` so two runners never silently clobber
 * each other's progress.
 */
const db = require('./db');

const CHAIN = 'robinhood';
const LIVE_NOTIFY_CHANNEL = 'robinhood_wallet_swap_live';
const STREAMS = new Set(['seed', 'live']);
const TERMINAL_SEED_STATES = new Set(['complete', 'abandoned']);

function stream(value) {
  const normalized = String(value ?? '').trim();
  if (!STREAMS.has(normalized)) throw new Error(`stream must be one of ${[...STREAMS].join(', ')}`);
  return normalized;
}

function nonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw).toString();
}

function optionalNonNegativeInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return nonNegativeInteger(value, label);
}

function optionalHash(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a 32-byte hex hash`);
  return normalized;
}

function normalizeCursor(row) {
  if (!row) return null;
  return {
    chain: row.chain,
    stream: row.stream,
    originBlock: row.origin_block == null ? null : String(row.origin_block),
    nextBlock: row.next_block == null ? null : String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null,
    checkpointTimestamp: row.checkpoint_timestamp
      ? new Date(row.checkpoint_timestamp).toISOString()
      : null,
    lifecycleState: row.lifecycle_state || null,
    stateReason: row.state_reason || null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    abandonedAt: row.abandoned_at ? new Date(row.abandoned_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    version: Number(row.version),
  };
}

function invalidRetentionGate(reason, cursors = {}) {
  return { valid: false, reason, completeThroughBlock: null, ...cursors };
}

function seedGateReason(seed) {
  if (!seed) return 'seed_missing';
  if (!TERMINAL_SEED_STATES.has(seed.lifecycleState)) return 'seed_incomplete';
  if (seed.lifecycleState === 'complete') {
    const complete = seed.safeHead != null && seed.nextBlock != null
      && BigInt(seed.nextBlock) > BigInt(seed.safeHead) && seed.completedAt != null;
    return complete ? null : 'seed_terminal_invalid';
  }
  return seed.stateReason && seed.abandonedAt != null ? null : 'seed_terminal_invalid';
}

function liveGateValidation(live, previousCompleteThroughBlock) {
  if (!live) return { reason: 'live_missing' };
  if (live.lifecycleState !== 'running') return { reason: 'live_not_running' };
  if (live.nextBlock == null || BigInt(live.nextBlock) === 0n || live.safeHead == null) {
    return { reason: 'live_frontier_invalid' };
  }
  const completeThrough = BigInt(live.nextBlock) - 1n;
  if (completeThrough > BigInt(live.safeHead)) return { reason: 'live_frontier_unproven' };
  const checkpointValid = live.checkpointBlock != null && live.checkpointHash != null
    && live.checkpointTimestamp != null && /^0x[0-9a-f]{64}$/.test(live.checkpointHash)
    && BigInt(live.checkpointBlock) <= completeThrough;
  if (!checkpointValid) return { reason: 'live_checkpoint_invalid' };
  if (previousCompleteThroughBlock != null
      && completeThrough < BigInt(previousCompleteThroughBlock)) {
    return { reason: 'watermark_regressed' };
  }
  return { reason: null, completeThrough };
}

function buildRetentionGate(rows, options = {}) {
  const cursors = Object.fromEntries((rows || []).map((row) => [row.stream, normalizeCursor(row)]));
  const seed = cursors.seed || null;
  const live = cursors.live || null;
  const seedReason = seedGateReason(seed);
  if (seedReason) return invalidRetentionGate(seedReason, { seed, live });
  const validation = liveGateValidation(live, options.previousCompleteThroughBlock);
  if (validation.reason) return invalidRetentionGate(validation.reason, { seed, live });
  return {
    valid: true,
    reason: null,
    consumer: 'wallet-attribution',
    completeThroughBlock: validation.completeThrough.toString(),
    sourceFrontierBlock: live.safeHead,
    checkpointBlock: live.checkpointBlock,
    checkpointHash: live.checkpointHash,
    version: live.version,
    updatedAt: live.updatedAt,
    seed,
    live,
  };
}

function checkpointPair(input) {
  const checkpointBlock = optionalNonNegativeInteger(input.checkpointBlock, 'checkpointBlock');
  const checkpointHash = optionalHash(input.checkpointHash, 'checkpointHash');
  if ((checkpointBlock === null) !== (checkpointHash === null)) {
    throw new Error('checkpointBlock and checkpointHash must be set together');
  }
  return { checkpointBlock, checkpointHash };
}

function liveCheckpoint(input, nextBlock) {
  const checkpoint = checkpointPair(input);
  const checkpointTimestamp = input.checkpointTimestamp == null
    ? null
    : new Date(input.checkpointTimestamp).toISOString();
  if ((checkpoint.checkpointBlock === null) !== (checkpointTimestamp === null)) {
    throw new Error('live checkpoint block, hash and timestamp must be set together');
  }
  if (
    checkpoint.checkpointBlock !== null
    && BigInt(checkpoint.checkpointBlock) >= BigInt(nextBlock)
  ) {
    throw new Error('live checkpointBlock must be lower than nextBlock');
  }
  return { ...checkpoint, checkpointTimestamp };
}

function createRobinhoodWalletSwapCursorRepository(options = {}) {
  const database = options.database || db;

  async function loadCursor(streamName) {
    const result = await database.query(
      `SELECT * FROM robinhood_wallet_swap_cursors WHERE chain = $1 AND stream = $2`,
      [CHAIN, stream(streamName)]
    );
    return normalizeCursor(result.rows[0]);
  }

  // Idempotent: creates the cursor if absent, never resets an existing one.
  async function initCursor(streamName, nextBlock, input = {}) {
    const start = nonNegativeInteger(nextBlock, 'nextBlock');
    const origin = input.originBlock == null
      ? start : nonNegativeInteger(input.originBlock, 'originBlock');
    if (BigInt(origin) > BigInt(start)) throw new Error('originBlock cannot exceed nextBlock');
    const safeHead = optionalNonNegativeInteger(input.safeHead, 'safeHead');
    await database.query(
      `INSERT INTO robinhood_wallet_swap_cursors (
         chain, stream, origin_block, next_block, safe_head
       ) VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint)
       ON CONFLICT (chain, stream) DO NOTHING`,
      [CHAIN, stream(streamName), origin, start, safeHead]
    );
    return loadCursor(streamName);
  }

  // Optimistic advance. Returns the updated cursor, or null on version mismatch
  // (another owner advanced it first).
  async function advanceCursor(streamName, input = {}) {
    const { checkpointBlock, checkpointHash } = checkpointPair(input);
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_cursors
       SET next_block = $3::bigint,
           safe_head = CASE
             WHEN $4::bigint IS NULL THEN safe_head
             ELSE GREATEST(COALESCE(safe_head, $4::bigint), $4::bigint)
           END,
           checkpoint_block = $5::bigint,
           checkpoint_hash = $6,
           checkpoint_timestamp = COALESCE($7::timestamptz, checkpoint_timestamp),
           lifecycle_state = 'running',
           state_reason = NULL,
           version = version + 1,
           updated_at = NOW()
       WHERE chain = $1 AND stream = $2 AND version = $8
         AND next_block <= $3::bigint
         AND (safe_head IS NULL OR $4::bigint IS NULL OR safe_head <= $4::bigint)
         AND lifecycle_state IN ('pending', 'running')
       RETURNING *`,
      [
        CHAIN,
        stream(streamName),
        nonNegativeInteger(input.nextBlock, 'nextBlock'),
        optionalNonNegativeInteger(input.safeHead, 'safeHead'),
        checkpointBlock,
        checkpointHash,
        input.checkpointTimestamp ? new Date(input.checkpointTimestamp).toISOString() : null,
        Number(input.expectedVersion),
      ]
    );
    return normalizeCursor(result.rows[0]);
  }

  // LIVE-only monotonic advance. Omitting checkpoint fields preserves the
  // current checkpoint, which allows a frontier-only update without erasing
  // the reorg guard. A stale version or any attempted regression returns null.
  async function advanceLiveCursor(input = {}) {
    const nextBlock = nonNegativeInteger(input.nextBlock, 'nextBlock');
    const safeHead = optionalNonNegativeInteger(input.safeHead, 'safeHead');
    const { checkpointBlock, checkpointHash, checkpointTimestamp } = liveCheckpoint(
      input,
      nextBlock
    );
    const result = await database.query(
      `WITH advanced AS (
       UPDATE robinhood_wallet_swap_cursors
       SET next_block = $3::bigint,
           safe_head = CASE
             WHEN $4::bigint IS NULL THEN safe_head
             ELSE GREATEST(COALESCE(safe_head, $4::bigint), $4::bigint)
           END,
           checkpoint_block = COALESCE($5::bigint, checkpoint_block),
           checkpoint_hash = COALESCE($6, checkpoint_hash),
           checkpoint_timestamp = COALESCE($7::timestamptz, checkpoint_timestamp),
           lifecycle_state = 'running',
           state_reason = NULL,
           version = version + 1,
           updated_at = NOW()
       WHERE chain = $1 AND stream = $2 AND version = $8
         AND next_block <= $3::bigint
         AND lifecycle_state IN ('pending', 'running')
         AND (safe_head IS NULL OR $4::bigint IS NULL OR safe_head <= $4::bigint)
         AND (
           checkpoint_block IS NULL
           OR $5::bigint IS NULL
           OR checkpoint_block <= $5::bigint
         )
       RETURNING *
       ) SELECT advanced.*, pg_notify($9, advanced.next_block::text) AS notified
           FROM advanced`,
      [
        CHAIN, 'live', nextBlock, safeHead, checkpointBlock, checkpointHash,
        checkpointTimestamp, Number(input.expectedVersion), LIVE_NOTIFY_CHANNEL,
      ]
    );
    return normalizeCursor(result.rows[0]);
  }

  async function completeSeed(input = {}) {
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_cursors
       SET lifecycle_state = 'complete', state_reason = NULL,
           completed_at = NOW(), abandoned_at = NULL,
           version = version + 1, updated_at = NOW()
       WHERE chain = $1 AND stream = 'seed' AND version = $2
         AND lifecycle_state IN ('pending', 'running')
         AND safe_head IS NOT NULL AND next_block > safe_head
       RETURNING *`,
      [CHAIN, Number(input.expectedVersion)]
    );
    return normalizeCursor(result.rows[0]);
  }

  async function abandonSeed(input = {}) {
    const reason = String(input.reason || '').trim();
    if (!reason || reason.length > 500) {
      throw new Error('seed abandonment requires a reason of at most 500 characters');
    }
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_cursors
       SET lifecycle_state = 'abandoned', state_reason = $3,
           completed_at = NULL, abandoned_at = NOW(),
           version = version + 1, updated_at = NOW()
       WHERE chain = $1 AND stream = 'seed' AND version = $2
         AND lifecycle_state IN ('pending', 'running')
       RETURNING *`,
      [CHAIN, Number(input.expectedVersion), reason]
    );
    return normalizeCursor(result.rows[0]);
  }

  async function loadRetentionGate(input = {}) {
    const result = await database.query(
      `SELECT * FROM robinhood_wallet_swap_cursors
       WHERE chain = $1 AND stream IN ('seed', 'live')`,
      [CHAIN]
    );
    return buildRetentionGate(result.rows, input);
  }

  return {
    loadCursor, initCursor, advanceCursor, advanceLiveCursor,
    completeSeed, abandonSeed, loadRetentionGate,
  };
}

module.exports = {
  createRobinhoodWalletSwapCursorRepository, LIVE_NOTIFY_CHANNEL,
  STREAMS,
  __private: { normalizeCursor, checkpointPair, liveCheckpoint, buildRetentionGate },
};
