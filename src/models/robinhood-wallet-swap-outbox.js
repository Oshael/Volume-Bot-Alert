'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const DEFAULT_MAX_ATTEMPTS = 5;

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw).toString();
}

function identity(entry, label) {
  const transactionHash = String(
    entry?.transactionHash ?? entry?.transaction_hash ?? ''
  ).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error(`${label}.transactionHash is invalid`);
  }
  return {
    transactionHash,
    logIndex: quantity(entry?.logIndex ?? entry?.log_index, `${label}.logIndex`),
  };
}

function retryEntry(entry, index) {
  return {
    ...identity(entry, `retry[${index}]`),
    error: String(entry?.error ?? '').slice(0, 4000),
    backoffMs: positiveInt(entry?.backoffMs ?? 1, `retry[${index}].backoffMs`),
  };
}

function mapRow(row) {
  return {
    ...identity(row, 'claimed'),
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionIndex: String(row.transaction_index),
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
  };
}

function compareRows(left, right) {
  for (const field of ['blockNumber', 'transactionIndex', 'logIndex']) {
    const result = BigInt(left[field]) - BigInt(right[field]);
    if (result !== 0n) return result < 0n ? -1 : 1;
  }
  return 0;
}

function createRobinhoodWalletSwapOutboxRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  async function claimFinalized(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('wallet swap owner is required');
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const throughBlock = quantity(input.throughBlock, 'throughBlock');
    const result = await database.query(
      `WITH claimable AS (
         SELECT outbox.transaction_hash, outbox.log_index
         FROM robinhood_wallet_swap_outbox outbox
         INNER JOIN robinhood_chain_blocks block
           ON block.chain = outbox.chain
          AND block.block_number = outbox.block_number
          AND block.block_hash = outbox.block_hash
          AND block.canonical
         WHERE outbox.chain = '${CHAIN}' AND outbox.status = 'pending'
           AND outbox.next_attempt_at <= NOW() AND outbox.block_number <= $4::bigint
         ORDER BY outbox.block_number, outbox.transaction_index, outbox.log_index
         LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
       )
       UPDATE robinhood_wallet_swap_outbox outbox
       SET status='leased', lease_owner=$1,
           lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
           attempt_count=outbox.attempt_count+1, updated_at=NOW()
       FROM claimable
       WHERE outbox.chain='${CHAIN}'
         AND outbox.transaction_hash=claimable.transaction_hash
         AND outbox.log_index=claimable.log_index
       RETURNING outbox.*`,
      [owner, limit, leaseMs, throughBlock]
    );
    return result.rows.map(mapRow).sort(compareRows);
  }

  async function settle(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('wallet swap owner is required');
    const delivered = (input.delivered || []).map((row, index) => identity(row, `delivered[${index}]`));
    const retry = (input.retry || []).map(retryEntry);
    const maxAttempts = positiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      let deliveredCount = 0;
      if (delivered.length) {
        const result = await client.query(
          `DELETE FROM robinhood_wallet_swap_outbox outbox
           USING jsonb_to_recordset($1::jsonb) AS item(
             "transactionHash" text, "logIndex" bigint
           )
           WHERE outbox.chain='${CHAIN}' AND outbox.status='leased'
             AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
             AND outbox.transaction_hash=item."transactionHash"
             AND outbox.log_index=item."logIndex"`,
          [JSON.stringify(delivered), owner]
        );
        deliveredCount = result.rowCount;
      }
      let retried = 0;
      let blocked = 0;
      if (retry.length) {
        const result = await client.query(
          `UPDATE robinhood_wallet_swap_outbox outbox
           SET status=CASE WHEN outbox.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
               lease_owner=NULL, lease_until=NULL,
               next_attempt_at=CASE WHEN outbox.attempt_count >= $3
                 THEN outbox.next_attempt_at
                 ELSE NOW()+(item."backoffMs"::bigint*INTERVAL '1 millisecond') END,
               last_error=item.error, updated_at=NOW()
           FROM jsonb_to_recordset($1::jsonb) AS item(
             "transactionHash" text, "logIndex" bigint, error text, "backoffMs" bigint
           )
           WHERE outbox.chain='${CHAIN}' AND outbox.status='leased'
             AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
             AND outbox.transaction_hash=item."transactionHash"
             AND outbox.log_index=item."logIndex"
           RETURNING outbox.status`,
          [JSON.stringify(retry), owner, maxAttempts]
        );
        blocked = result.rows.filter((row) => row.status === 'blocked').length;
        retried = result.rowCount - blocked;
      }
      await client.query('COMMIT');
      return { delivered: deliveredCount, retried, blocked };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function reclaimExpired() {
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_outbox
       SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
       WHERE chain=$1 AND status='leased' AND lease_until<=NOW()`, [CHAIN]
    );
    return result.rowCount;
  }

  async function readFinalizedBlock() {
    const result = await database.query(
      `SELECT CASE WHEN finalized_head IS NULL OR checkpoint_block IS NULL THEN NULL
              ELSE LEAST(finalized_head, checkpoint_block)::text END AS finalized_head
       FROM robinhood_chain_capture_cursor WHERE chain=$1`, [CHAIN]
    );
    return result.rows[0]?.finalized_head ?? null;
  }

  // Preserve the public retention watermark without retaining the old reader.
  // Pending processing and outbox work both fence progress, so a late V4 item
  // can never appear below a cursor already advertised as complete.
  async function advanceCompatibilityWatermark(throughBlock) {
    if (throughBlock == null) return null;
    const through = quantity(throughBlock, 'throughBlock');
    const result = await database.query(
      `WITH frontier AS MATERIALIZED (
         SELECT LEAST(
           $2::bigint,
           COALESCE((SELECT MIN(block_number)-1 FROM robinhood_head_captures
             WHERE chain=$1 AND stream='market'
               AND processing_status IN ('pending','leased','blocked')), $2::bigint),
           COALESCE((SELECT MIN(block_number)-1 FROM robinhood_wallet_swap_outbox
             WHERE chain=$1 AND status IN ('pending','leased','blocked')), $2::bigint)
         ) AS block_number
       ), checkpoint AS MATERIALIZED (
         SELECT block.block_number, block.block_hash, block.block_timestamp
         FROM frontier INNER JOIN robinhood_chain_blocks block
           ON block.chain=$1 AND block.canonical
          AND block.block_number=frontier.block_number
       ), advanced AS (
       UPDATE robinhood_wallet_swap_cursors cursor
       SET next_block=checkpoint.block_number+1,
           safe_head=GREATEST(COALESCE(cursor.safe_head,0),checkpoint.block_number),
           checkpoint_block=checkpoint.block_number,
           checkpoint_hash=checkpoint.block_hash,
           checkpoint_timestamp=checkpoint.block_timestamp,
           lifecycle_state='running', state_reason=NULL,
           version=cursor.version+1, updated_at=NOW()
       FROM checkpoint
       WHERE cursor.chain=$1 AND cursor.stream='live'
         AND cursor.next_block < checkpoint.block_number+1
       RETURNING cursor.next_block
       )
       SELECT (next_block-1)::text AS complete_through_block FROM advanced
       UNION ALL
       SELECT (cursor.next_block-1)::text
       FROM robinhood_wallet_swap_cursors cursor
       WHERE cursor.chain=$1 AND cursor.stream='live'
         AND NOT EXISTS (SELECT 1 FROM advanced)
       LIMIT 1`,
      [CHAIN, through]
    );
    return result.rows[0]?.complete_through_block ?? null;
  }

  // One-time cutover fence: rows below the frozen legacy LIVE cursor were
  // already attributed by the old reader and must not be replayed to the UI.
  async function discardLegacyCovered() {
    const result = await database.query(
      `DELETE FROM robinhood_wallet_swap_outbox outbox
       USING robinhood_wallet_swap_cursors cursor
       WHERE outbox.chain=$1 AND outbox.status='pending'
         AND cursor.chain=outbox.chain AND cursor.stream='live'
         AND outbox.block_number < cursor.next_block`, [CHAIN]
    );
    return result.rowCount;
  }

  return Object.freeze({
    advanceCompatibilityWatermark, claimFinalized, discardLegacyCovered,
    readFinalizedBlock, reclaimExpired, settle,
  });
}

module.exports = {
  createRobinhoodWalletSwapOutboxRepository,
  DEFAULT_MAX_ATTEMPTS,
  __private: { compareRows, identity, mapRow },
};
