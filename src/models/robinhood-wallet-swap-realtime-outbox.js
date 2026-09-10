'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_wallet_swap_realtime_outbox';

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

function createRobinhoodWalletSwapRealtimeOutboxRepository(options = {}) {
  const database = options.database || db;

  async function promoteFinalized(input = {}) {
    const throughBlock = quantity(input.throughBlock, 'throughBlock');
    const limit = positiveInt(input.limit, 'limit');
    const result = await database.query(
      `WITH promotable AS MATERIALIZED (
         SELECT observed.chain, observed.transaction_hash, observed.log_index,
                observed.block_number, observed.block_hash,
                observed.transaction_index, observed.payload
           FROM robinhood_wallet_swap_realtime_outbox observed
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=observed.chain
            AND block.block_number=observed.block_number
            AND block.block_hash=observed.block_hash
            AND block.canonical
           LEFT JOIN robinhood_wallet_swap_realtime_outbox finalized
             ON finalized.chain=observed.chain
            AND finalized.transaction_hash=observed.transaction_hash
            AND finalized.log_index=observed.log_index
            AND finalized.event_kind='finalized'
          WHERE observed.chain='${CHAIN}' AND observed.event_kind='observed'
            AND observed.block_number <= $1::bigint
            AND finalized.transaction_hash IS NULL
          ORDER BY observed.block_number, observed.transaction_index, observed.log_index
          LIMIT $2
       ), inserted AS (
         INSERT INTO robinhood_wallet_swap_realtime_outbox(
           chain, transaction_hash, log_index, event_kind, block_number,
           block_hash, transaction_index, payload
         )
         SELECT chain, transaction_hash, log_index, 'finalized', block_number,
                block_hash, transaction_index,
                payload || jsonb_build_object(
                  'type', 'market:trade:finalized',
                  'finality', 'finalized',
                  'finalizedAt', clock_timestamp()
                )
           FROM promotable
         ON CONFLICT (chain, transaction_hash, log_index, event_kind) DO NOTHING
         RETURNING block_number
       ), notified AS (
         SELECT pg_notify($3, MAX(block_number)::text) AS sent
           FROM inserted HAVING COUNT(*) > 0
       )
       SELECT COUNT(*)::int AS promoted,
              (SELECT COUNT(*)::int FROM notified) AS notifications
         FROM inserted`,
      [throughBlock, limit, NOTIFY_CHANNEL]
    );
    return Number(result.rows[0]?.promoted || 0);
  }

  return Object.freeze({ promoteFinalized });
}

module.exports = {
  NOTIFY_CHANNEL,
  createRobinhoodWalletSwapRealtimeOutboxRepository,
};
