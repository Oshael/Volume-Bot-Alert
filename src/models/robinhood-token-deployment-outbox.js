const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const EXACT_SOURCES = [
  'blockscout_internal', 'rpc_code_transition', 'rpc_direct', 'rpc_trace', 'launchpad_event',
];

function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('deployment outbox owner is invalid');
  return owner;
}

function createRobinhoodTokenDeploymentOutboxRepository(options = {}) {
  const database = options.database || db;

  async function claim(input = {}) {
    const owner = ownerOf(input.owner);
    const leaseMs = Math.max(10_000, Math.min(Number(input.leaseMs) || 300_000, 900_000));
    const { rows } = await database.query(
      `WITH candidate AS (
         SELECT token_address FROM robinhood_token_deployment_outbox
          WHERE chain = '${CHAIN}' AND next_attempt_at <= NOW()
            AND (status = 'pending' OR lease_until <= NOW())
          ORDER BY
            CASE WHEN created_at >= NOW() - INTERVAL '10 minutes' THEN 0 ELSE 1 END,
            next_attempt_at, created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE robinhood_token_deployment_outbox outbox
          SET status = 'leased', lease_owner = $1,
              lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              attempt_count = attempt_count + 1, updated_at = NOW()
         FROM candidate WHERE outbox.chain = '${CHAIN}'
          AND outbox.token_address = candidate.token_address
       RETURNING outbox.token_address, outbox.attempt_count, outbox.created_at`,
      [owner, leaseMs]
    );
    return rows[0] ? Object.freeze({
      tokenAddress: rows[0].token_address, attemptCount: Number(rows[0].attempt_count),
      createdAt: rows[0].created_at,
    }) : null;
  }

  async function findMintHint(tokenAddress) {
    const { rows } = await database.query(
      `SELECT block_number, block_hash, transaction_hash
         FROM robinhood_holder_transfer_journal
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND applied = false
          AND from_wallet = '0x0000000000000000000000000000000000000000'
        ORDER BY block_number, transaction_index, log_index LIMIT 1`,
      [normalizeTokenAddress(CHAIN, tokenAddress)]
    );
    return rows[0] ? Object.freeze({
      tokenAddress: normalizeTokenAddress(CHAIN, tokenAddress),
      blockNumber: String(rows[0].block_number),
      blockHash: rows[0].block_hash,
      transactionHash: rows[0].transaction_hash,
    }) : null;
  }

  async function isExact(tokenAddress) {
    const address = normalizeTokenAddress(CHAIN, tokenAddress);
    const result = await database.query(
      `SELECT 1 FROM robinhood_token_attributions
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND source = ANY($2::varchar[]) AND attribution_block IS NOT NULL LIMIT 1`,
      [address, EXACT_SOURCES]
    );
    return result.rowCount === 1;
  }

  async function complete(input = {}) {
    const result = await database.query(
      `DELETE FROM robinhood_token_deployment_outbox
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND status = 'leased' AND lease_owner = $2`,
      [normalizeTokenAddress(CHAIN, input.tokenAddress), ownerOf(input.owner)]
    );
    return result.rowCount === 1;
  }

  async function retry(input = {}) {
    const retryMs = Math.max(1000, Math.min(Number(input.retryMs) || 15_000, 3_600_000));
    const result = await database.query(
      `UPDATE robinhood_token_deployment_outbox
          SET status = 'pending', lease_owner = NULL, lease_until = NULL,
              next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
              last_error = $4, updated_at = NOW()
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND status = 'leased' AND lease_owner = $2`,
      [normalizeTokenAddress(CHAIN, input.tokenAddress), ownerOf(input.owner), retryMs,
        String(input.error || 'deployment_resolution_failed').slice(0, 500)]
    );
    return result.rowCount === 1;
  }

  return Object.freeze({ claim, complete, findMintHint, isExact, retry });
}

module.exports = { createRobinhoodTokenDeploymentOutboxRepository };
