const db = require('./db');

const CHAIN = 'robinhood';

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function timestamp(value, label) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function mapCursor(row) {
  if (!row) return null;
  return Object.freeze({
    coverageStartBlock: String(row.coverage_start_block),
    nextBlock: String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpoint: row.checkpoint_block == null ? null : Object.freeze({
      number: String(row.checkpoint_block),
      hash: String(row.checkpoint_hash),
      timestampMs: row.checkpoint_timestamp == null
        ? null : new Date(row.checkpoint_timestamp).getTime(),
    }),
    version: Number(row.version),
  });
}

function cursorConflict(message) {
  const error = new Error(message);
  error.code = 'liquidity_event_cursor_conflict';
  return error;
}

function createRobinhoodPoolLiquidityEventCursorRepository(options = {}) {
  const database = options.database || db;

  async function loadCursor() {
    const result = await database.query(
      `SELECT coverage_start_block, next_block, safe_head, checkpoint_block,
              checkpoint_hash, checkpoint_timestamp, version
         FROM robinhood_pool_liquidity_event_cursors
        WHERE chain = $1`,
      [CHAIN]
    );
    return mapCursor(result.rows[0]);
  }

  async function initializeCursor(input = {}) {
    const startBlock = quantity(input.startBlock, 'startBlock');
    const result = await database.query(
      `INSERT INTO robinhood_pool_liquidity_event_cursors (
         chain, coverage_start_block, next_block
       ) VALUES ($1, $2, $2)
       ON CONFLICT (chain) DO NOTHING
       RETURNING coverage_start_block, next_block, safe_head, checkpoint_block,
                 checkpoint_hash, checkpoint_timestamp, version`,
      [CHAIN, startBlock]
    );
    const cursor = result.rowCount ? mapCursor(result.rows[0]) : await loadCursor();
    if (!cursor || cursor.coverageStartBlock !== startBlock) {
      throw cursorConflict('Liquidity event coverage start does not match');
    }
    return cursor;
  }

  async function commitRange(input = {}) {
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const nextBlock = quantity(input.nextBlock, 'nextBlock');
    if (BigInt(nextBlock) <= BigInt(fromBlock)) throw new Error('nextBlock must advance');
    const checkpoint = input.checkpoint || {};
    const checkpointBlock = quantity(checkpoint.number, 'checkpoint.number');
    if (BigInt(checkpointBlock) !== BigInt(nextBlock) - 1n) {
      throw new Error('checkpoint must be immediately before nextBlock');
    }
    const result = await database.query(
      `UPDATE robinhood_pool_liquidity_event_cursors
          SET next_block = $3, safe_head = $4, checkpoint_block = $5,
              checkpoint_hash = $6, checkpoint_timestamp = $7,
              version = version + 1, updated_at = NOW()
        WHERE chain = $1 AND next_block = $2
        RETURNING coverage_start_block, next_block, safe_head, checkpoint_block,
                  checkpoint_hash, checkpoint_timestamp, version`,
      [
        CHAIN, fromBlock, nextBlock,
        input.safeHead == null ? null : quantity(input.safeHead, 'safeHead'),
        checkpointBlock, hash(checkpoint.hash, 'checkpoint.hash'),
        timestamp(checkpoint.timestampMs, 'checkpoint.timestampMs'),
      ]
    );
    if (!result.rowCount) throw cursorConflict('Liquidity event range is not contiguous');
    return mapCursor(result.rows[0]);
  }

  async function rewindCursor(input = {}) {
    const rewindBlock = quantity(input.rewindBlock, 'rewindBlock');
    const result = await database.query(
      `UPDATE robinhood_pool_liquidity_event_cursors
          SET next_block = $2, safe_head = NULL, checkpoint_block = NULL,
              checkpoint_hash = NULL, checkpoint_timestamp = NULL,
              version = version + 1, updated_at = NOW()
        WHERE chain = $1 AND coverage_start_block <= $2 AND next_block > $2
        RETURNING coverage_start_block, next_block, safe_head, checkpoint_block,
                  checkpoint_hash, checkpoint_timestamp, version`,
      [CHAIN, rewindBlock]
    );
    if (!result.rowCount) throw cursorConflict('Liquidity event cursor cannot rewind there');
    return mapCursor(result.rows[0]);
  }

  async function resolveProcessingFrontier() {
    const { rows } = await database.query(
      `WITH cursors AS (
         SELECT COUNT(*) = 2 AND COUNT(checkpoint_block) = 2 AS ready
           FROM robinhood_head_capture_cursors
          WHERE chain = $1 AND stream IN ('discovery', 'market')
       ), pending AS (
         SELECT MIN(active.block_number) AS pending_block
           FROM (
             (SELECT outbox.block_number
                FROM robinhood_chain_domain_outbox outbox
               WHERE outbox.chain = $1 AND outbox.status <> 'complete'
               ORDER BY outbox.block_number, outbox.status, outbox.domain,
                        outbox.transaction_index, outbox.log_index LIMIT 1)
             UNION ALL
             (SELECT capture.block_number
                FROM robinhood_head_captures capture
               WHERE capture.chain = $1
                 AND capture.processing_status IN ('pending', 'leased', 'blocked')
               ORDER BY capture.block_number, capture.transaction_index,
                        capture.log_index LIMIT 1)
           ) active
       )
       SELECT CASE WHEN cursors.ready IS NOT TRUE THEN NULL
                   WHEN pending.pending_block IS NULL THEN canonical.checkpoint_block
                   ELSE LEAST(canonical.checkpoint_block, pending.pending_block - 1)
               END AS checkpoint_block,
              pending.pending_block
         FROM robinhood_chain_capture_cursor canonical
         CROSS JOIN cursors CROSS JOIN pending
        WHERE canonical.chain = $1`,
      [CHAIN]
    );
    if (rows[0]?.checkpoint_block == null) return null;
    const frontier = BigInt(rows[0].checkpoint_block);
    return frontier >= 0n ? frontier.toString() : null;
  }

  return Object.freeze({
    commitRange, initializeCursor, loadCursor, resolveProcessingFrontier, rewindCursor,
  });
}

module.exports = { createRobinhoodPoolLiquidityEventCursorRepository };
