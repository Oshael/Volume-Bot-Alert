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

  return Object.freeze({ claimFinalized, reclaimExpired, settle });
}

module.exports = {
  createRobinhoodWalletSwapOutboxRepository,
  DEFAULT_MAX_ATTEMPTS,
  __private: { compareRows, identity, mapRow },
};
