'use strict';

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_wallet_swap_outbox';
const REALTIME_NOTIFY_CHANNEL = 'robinhood_wallet_swap_realtime_outbox';

function normalizeTargets(observations = []) {
  if (!Array.isArray(observations)) throw new TypeError('accepted observations must be a list');
  const targets = observations.map((observation, index) => {
    const transactionHash = String(observation?.transactionHash || '').trim().toLowerCase();
    const logIndex = String(observation?.logIndex ?? '').trim();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw new Error(`observations[${index}].transactionHash is invalid`);
    }
    if (!/^\d+$/.test(logIndex)) throw new Error(`observations[${index}].logIndex is invalid`);
    return { transactionHash, logIndex: BigInt(logIndex).toString() };
  });
  if (new Set(targets.map((row) => `${row.transactionHash}:${row.logIndex}`)).size
      !== targets.length) {
    throw new Error('accepted observations contain duplicate identities');
  }
  return targets;
}

function createRobinhoodWalletSwapOutboxProducer() {
  async function appendAccepted(client, observations = []) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError('wallet-swap outbox producer requires a transaction client');
    }
    const targets = normalizeTargets(observations);
    if (!targets.length) {
      return { requested: 0, eligible: 0, inserted: 0, realtimeInserted: 0 };
    }
    const result = await client.query(
      `WITH input AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS target(
           "transactionHash" text, "logIndex" bigint
         )
       ), eligible AS MATERIALIZED (
         SELECT observation.*, block.block_hash, block.block_timestamp,
           block.head_observed_at, block.receipts_available_at, block.captured_at,
           transaction.transaction_index, transaction.from_address
         FROM input target
         INNER JOIN robinhood_market_observations observation
           ON observation.chain = '${CHAIN}'
          AND observation.transaction_hash = target."transactionHash"
          AND observation.log_index = target."logIndex"
          AND observation.status = 'accepted'
         INNER JOIN robinhood_processed_logs processed
           ON processed.chain = observation.chain
          AND processed.transaction_hash = observation.transaction_hash
          AND processed.log_index = observation.log_index
         INNER JOIN robinhood_chain_blocks block
           ON block.chain = processed.chain
          AND block.block_hash = processed.block_hash
          AND block.block_number = observation.block_number
          AND block.canonical
         INNER JOIN robinhood_chain_transactions transaction
           ON transaction.chain = block.chain
          AND transaction.block_hash = block.block_hash
          AND transaction.transaction_hash = observation.transaction_hash
       ), prepared AS MATERIALIZED (
         SELECT eligible.*, clock_timestamp() AS observation_committed_at
         FROM eligible
       ), payloads AS MATERIALIZED (
         SELECT prepared.*,
           jsonb_build_object(
             'walletAddress', from_address,
             'transactionHash', transaction_hash,
             'actionIndex', log_index::text,
             'blockNumber', block_number::text,
             'blockHash', block_hash,
             'transactionIndex', transaction_index::text,
             'blockTime', block_timestamp,
             'protocol', protocol,
             'marketKey', market_key,
             'tokenAddress', token_address,
             'quoteAddress', quote_address,
             'side', side,
             'tokenAmountRaw', token_amount_raw::text,
             'quoteAmountRaw', quote_amount_raw::text,
             'tokenDecimals', token_decimals,
             'quoteDecimals', quote_decimals,
             'tokenAmount', token_amount::text,
             'quoteAmount', quote_amount::text,
             'priceUsd', price_usd::text,
             'volumeUsd', volume_usd::text,
             'fdvUsd', fdv_usd::text,
             'tokenTotalSupplyRaw', token_total_supply_raw::text,
             'parserVersion', 'rh-wallet-outbox-1',
             'latency', jsonb_build_object(
               'headObservedAt', head_observed_at,
               'receiptsAvailableAt', receipts_available_at,
               'captureCommittedAt', captured_at,
               'observationCommittedAt', observation_committed_at
             )
           ) AS payload
         FROM prepared
       ), inserted AS (
         INSERT INTO robinhood_wallet_swap_outbox (
           chain, transaction_hash, log_index, block_number, block_hash,
           transaction_index, payload
         )
         SELECT chain, transaction_hash, log_index, block_number, block_hash,
           transaction_index, payload
         FROM payloads
         ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
         RETURNING block_number
       ), realtime_inserted AS (
         INSERT INTO robinhood_wallet_swap_realtime_outbox (
           chain, transaction_hash, log_index, event_kind, block_number,
           block_hash, transaction_index, payload
         )
         SELECT chain, transaction_hash, log_index, 'observed', block_number,
           block_hash, transaction_index,
           payload || jsonb_build_object(
             'protocolVersion', 2,
             'type', 'market:trade:observed',
             'finality', 'observed',
             'asOfBlock', block_number::text,
             'asOfBlockHash', block_hash,
             'observedAt', observation_committed_at
           )
         FROM payloads
         ON CONFLICT (chain, transaction_hash, log_index, event_kind) DO NOTHING
         RETURNING block_number
       ), notified AS (
         SELECT pg_notify($2, MAX(block_number)::text) AS sent
         FROM inserted HAVING COUNT(*) > 0
       ), realtime_notified AS (
         SELECT pg_notify($3, MAX(block_number)::text) AS sent
         FROM realtime_inserted HAVING COUNT(*) > 0
       )
       SELECT
         (SELECT COUNT(*)::int FROM input) AS requested,
         (SELECT COUNT(*)::int FROM eligible) AS eligible,
         (SELECT COUNT(*)::int FROM inserted) AS inserted,
         (SELECT COUNT(*)::int FROM realtime_inserted) AS realtime_inserted,
         (SELECT COUNT(*)::int FROM notified) AS notifications,
         (SELECT COUNT(*)::int FROM realtime_notified) AS realtime_notifications`,
      [JSON.stringify(targets), NOTIFY_CHANNEL, REALTIME_NOTIFY_CHANNEL]
    );
    const row = result.rows[0] || {};
    const summary = {
      requested: Number(row.requested || 0),
      eligible: Number(row.eligible || 0),
      inserted: Number(row.inserted || 0),
      realtimeInserted: Number(row.realtime_inserted || 0),
    };
    if (summary.eligible !== summary.requested) {
      const error = new Error('accepted wallet swap is missing committed canonical context');
      error.code = 'wallet_swap_canonical_context_missing';
      throw error;
    }
    return summary;
  }

  return Object.freeze({ appendAccepted });
}

module.exports = {
  NOTIFY_CHANNEL,
  REALTIME_NOTIFY_CHANNEL,
  createRobinhoodWalletSwapOutboxProducer,
  __private: { normalizeTargets },
};
