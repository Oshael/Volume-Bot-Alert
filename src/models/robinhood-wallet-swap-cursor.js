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
const STREAMS = new Set(['seed', 'live']);

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
    nextBlock: row.next_block == null ? null : String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null,
    checkpointTimestamp: row.checkpoint_timestamp
      ? new Date(row.checkpoint_timestamp).toISOString()
      : null,
    version: Number(row.version),
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
    const safeHead = optionalNonNegativeInteger(input.safeHead, 'safeHead');
    await database.query(
      `INSERT INTO robinhood_wallet_swap_cursors (chain, stream, next_block, safe_head)
       VALUES ($1, $2, $3::bigint, $4::bigint)
       ON CONFLICT (chain, stream) DO NOTHING`,
      [CHAIN, stream(streamName), nonNegativeInteger(nextBlock, 'nextBlock'), safeHead]
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
           safe_head = COALESCE($4::bigint, safe_head),
           checkpoint_block = $5::bigint,
           checkpoint_hash = $6,
           checkpoint_timestamp = COALESCE($7::timestamptz, checkpoint_timestamp),
           version = version + 1,
           updated_at = NOW()
       WHERE chain = $1 AND stream = $2 AND version = $8
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
      `UPDATE robinhood_wallet_swap_cursors
       SET next_block = $3::bigint,
           safe_head = CASE
             WHEN $4::bigint IS NULL THEN safe_head
             ELSE GREATEST(COALESCE(safe_head, $4::bigint), $4::bigint)
           END,
           checkpoint_block = COALESCE($5::bigint, checkpoint_block),
           checkpoint_hash = COALESCE($6, checkpoint_hash),
           checkpoint_timestamp = COALESCE($7::timestamptz, checkpoint_timestamp),
           version = version + 1,
           updated_at = NOW()
       WHERE chain = $1 AND stream = $2 AND version = $8
         AND next_block <= $3::bigint
         AND (safe_head IS NULL OR $4::bigint IS NULL OR safe_head <= $4::bigint)
         AND (
           checkpoint_block IS NULL
           OR $5::bigint IS NULL
           OR checkpoint_block <= $5::bigint
         )
       RETURNING *`,
      [
        CHAIN, 'live', nextBlock, safeHead, checkpointBlock, checkpointHash,
        checkpointTimestamp, Number(input.expectedVersion),
      ]
    );
    return normalizeCursor(result.rows[0]);
  }

  return { loadCursor, initCursor, advanceCursor, advanceLiveCursor };
}

module.exports = {
  createRobinhoodWalletSwapCursorRepository,
  STREAMS,
  __private: { normalizeCursor, checkpointPair, liveCheckpoint },
};
