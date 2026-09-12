const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../services/evm-erc20-supply-delta');

const CHAIN = 'robinhood';
const EXACT_SOURCES = [
  'blockscout_internal', 'rpc_code_transition', 'rpc_direct', 'rpc_trace', 'launchpad_event',
];

function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('deployment outbox owner is invalid');
  return owner;
}

function batchLimit(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 256) {
    throw new Error('deployment outbox limit is invalid');
  }
  return parsed;
}

function claimedTask(row) {
  const mintHint = row.mint_block_number == null ? null : Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    blockNumber: String(row.mint_block_number),
    blockHash: row.mint_block_hash,
    transactionHash: row.mint_transaction_hash,
  });
  return Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    attemptCount: Number(row.attempt_count), createdAt: row.created_at, mintHint,
  });
}

function createRobinhoodTokenDeploymentOutboxRepository(options = {}) {
  const database = options.database || db;

  async function claimBatch(input = {}) {
    const owner = ownerOf(input.owner);
    const leaseMs = Math.max(10_000, Math.min(Number(input.leaseMs) || 300_000, 900_000));
    const limit = batchLimit(input.limit);
    const { rows } = await database.query(
      `WITH candidate AS (
         SELECT token_address FROM robinhood_token_deployment_outbox
          WHERE chain = '${CHAIN}' AND next_attempt_at <= NOW()
            AND (status = 'pending' OR lease_until <= NOW())
          ORDER BY
            CASE WHEN mint_block_number IS NOT NULL THEN 0
                 WHEN created_at >= NOW() - INTERVAL '10 minutes' THEN 1 ELSE 2 END,
            mint_block_number DESC NULLS LAST,
            next_attempt_at, created_at
          LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       UPDATE robinhood_token_deployment_outbox outbox
          SET status = 'leased', lease_owner = $1,
              lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              attempt_count = attempt_count + 1, updated_at = NOW()
         FROM candidate WHERE outbox.chain = '${CHAIN}'
          AND outbox.token_address = candidate.token_address
       RETURNING outbox.token_address, outbox.attempt_count, outbox.created_at,
                 outbox.mint_block_number, outbox.mint_block_hash,
                 outbox.mint_transaction_hash`,
      [owner, leaseMs, limit]
    );
    return Object.freeze(rows.map(claimedTask));
  }

  async function claim(input = {}) {
    return (await claimBatch({ ...input, limit: 1 }))[0] || null;
  }

  async function findMintHint(tokenAddress, input = {}) {
    const parsedConfirmations = input.confirmations == null ? 12 : Number(input.confirmations);
    const confirmations = Number.isSafeInteger(parsedConfirmations)
      ? Math.max(0, Math.min(parsedConfirmations, 1000)) : 12;
    const parsedLookback = input.lookbackBlocks == null ? 96 : Number(input.lookbackBlocks);
    const lookbackBlocks = Number.isSafeInteger(parsedLookback)
      ? Math.max(confirmations + 2, Math.min(parsedLookback, 1000)) : 96;
    const { rows } = await database.query(
      `SELECT event.block_number, event.block_hash, event.transaction_hash
         FROM robinhood_chain_events event
         INNER JOIN robinhood_chain_blocks block
           ON block.chain=event.chain AND block.block_hash=event.block_hash
          AND block.canonical=TRUE
         CROSS JOIN robinhood_chain_capture_cursor cursor
        WHERE event.chain='${CHAIN}' AND cursor.chain=event.chain
          AND event.address=$1 AND event.topic0=$3 AND event.topics->>1=$4
          AND event.block_number >= GREATEST(cursor.node_head - $5::bigint, 0)
          AND event.block_number <= LEAST(
            cursor.checkpoint_block, GREATEST(cursor.node_head - $2::bigint, 0)
          )
        ORDER BY event.block_number, event.transaction_index, event.log_index LIMIT 1`,
      [normalizeTokenAddress(CHAIN, tokenAddress), confirmations, TRANSFER_TOPIC, ZERO_TOPIC,
        lookbackBlocks]
    );
    return rows[0] ? Object.freeze({
      tokenAddress: normalizeTokenAddress(CHAIN, tokenAddress),
      blockNumber: String(rows[0].block_number),
      blockHash: rows[0].block_hash,
      transactionHash: rows[0].transaction_hash,
    }) : null;
  }

  async function findDiscoveryHint(tokenAddress) {
    const normalized = normalizeTokenAddress(CHAIN, tokenAddress);
    const { rows } = await database.query(
      `SELECT discovery_block, discovery_block_hash, discovery_tx_hash
         FROM robinhood_pool_registry
        WHERE chain = '${CHAIN}' AND token_address = $1 AND active = TRUE
        ORDER BY discovery_block, discovery_log_index LIMIT 1`,
      [normalized]
    );
    return rows[0] ? Object.freeze({
      tokenAddress: normalized,
      blockNumber: String(rows[0].discovery_block),
      blockHash: rows[0].discovery_block_hash,
      transactionHash: rows[0].discovery_tx_hash,
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

  return Object.freeze({
    claim, claimBatch, complete, findDiscoveryHint, findMintHint, isExact, retry,
  });
}

module.exports = { createRobinhoodTokenDeploymentOutboxRepository };
