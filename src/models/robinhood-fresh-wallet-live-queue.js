const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { RULE_VERSION } = require('../services/robinhood-fresh-wallet-rule');

const CHAIN = 'robinhood';
const bounded = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
};

function createRobinhoodFreshWalletLiveQueueRepository(options = {}) {
  const database = options.database || db;

  async function claimBatch(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('FRESH queue owner is invalid');
    const leaseMs = bounded(input.leaseMs, 300_000, 10_000, 1_200_000);
    const limit = bounded(input.limit, 10, 1, 100);
    const { rows } = await database.query(`WITH candidates AS MATERIALIZED (
      SELECT queue.chain, queue.token_address, queue.wallet_address, queue.rule_version
        FROM robinhood_fresh_wallet_queue queue
        INNER JOIN robinhood_fresh_wallet_activations activation USING (chain, rule_version)
       WHERE queue.chain = $1 AND queue.rule_version = $2
         AND queue.source_kind = 'live' AND activation.status = 'active'
         AND (queue.status = 'pending'
           OR (queue.status = 'leased' AND queue.lease_until <= NOW()))
         AND queue.next_attempt_at <= NOW()
       ORDER BY queue.next_attempt_at, queue.updated_at
       LIMIT $3 FOR UPDATE OF queue SKIP LOCKED
    ), claimed AS (
      UPDATE robinhood_fresh_wallet_queue queue SET
        status = 'leased', lease_owner = $4,
        lease_until = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
        attempt_count = attempt_count + 1, updated_at = NOW()
      FROM candidates WHERE queue.chain = candidates.chain
        AND queue.token_address = candidates.token_address
        AND queue.wallet_address = candidates.wallet_address
        AND queue.rule_version = candidates.rule_version
      RETURNING queue.*
    ) SELECT claimed.token_address, claimed.wallet_address,
             claimed.requested_version::text, claimed.attempt_count,
             first_buy.transaction_hash, first_buy.block_number::text,
             first_buy.block_hash, first_buy.block_time
        FROM claimed INNER JOIN robinhood_wallet_token_first_buys first_buy USING (
          chain, token_address, wallet_address
        ) ORDER BY claimed.updated_at`, [CHAIN, RULE_VERSION, limit, owner, leaseMs]);
    return Object.freeze(rows.map((row) => Object.freeze({
      tokenAddress: row.token_address, walletAddress: row.wallet_address,
      requestedVersion: row.requested_version, attemptCount: Number(row.attempt_count),
      transactionHash: row.transaction_hash, blockNumber: row.block_number,
      blockHash: row.block_hash,
      blockTime: row.block_time?.toISOString?.() || String(row.block_time),
    })));
  }

  async function retry(input = {}) {
    const retryMs = bounded(input.retryMs, 15_000, 1000, 86_400_000);
    const result = await database.query(`UPDATE robinhood_fresh_wallet_queue SET
      status = 'pending', lease_owner = NULL, lease_until = NULL,
      next_attempt_at = NOW() + ($7::bigint * INTERVAL '1 millisecond'),
      last_error_code = $8, last_error_message = $9, updated_at = NOW()
      WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
        AND rule_version = $4 AND status = 'leased' AND lease_owner = $5
        AND requested_version = $6::bigint`, [
      CHAIN, normalizeTokenAddress(CHAIN, input.tokenAddress),
      normalizeTokenAddress(CHAIN, input.walletAddress), RULE_VERSION,
      input.owner, input.requestedVersion, retryMs,
      String(input.error?.code || 'fresh_wallet_live_error').slice(0, 64),
      String(input.error?.message || input.error || 'FRESH live failed').slice(0, 500),
    ]);
    return result.rowCount === 1;
  }

  return Object.freeze({ claimBatch, retry });
}

module.exports = { createRobinhoodFreshWalletLiveQueueRepository };
