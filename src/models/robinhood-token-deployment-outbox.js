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
    mintBlockTime: row.mint_block_time ?? null,
    mintAnchorRecordedAt: row.live_deadline_at == null ? null
      : new Date(new Date(row.live_deadline_at).getTime() - 72 * 60 * 60 * 1000).toISOString(),
  });
}

function createRobinhoodTokenDeploymentOutboxRepository(options = {}) {
  const database = options.database || db;

  async function claimBatchWithStats(input = {}) {
    const owner = ownerOf(input.owner);
    const leaseMs = Math.max(10_000, Math.min(Number(input.leaseMs) || 300_000, 900_000));
    const limit = batchLimit(input.limit);
    const { rows } = await database.query(
      `WITH candidate AS MATERIALIZED (
         SELECT outbox.token_address FROM robinhood_token_deployment_outbox outbox
          WHERE outbox.chain = '${CHAIN}' AND outbox.next_attempt_at <= NOW()
            AND outbox.live_deadline_at > NOW()
            AND (outbox.status = 'pending' OR outbox.lease_until <= NOW())
          ORDER BY CASE WHEN mint_block_number IS NOT NULL
                              AND created_at >= NOW() - INTERVAL '30 seconds'
                         THEN 0 ELSE 1 END,
                   CASE WHEN mint_block_number IS NOT NULL
                              AND created_at >= NOW() - INTERVAL '30 seconds'
                         THEN created_at END DESC,
                   live_deadline_at, next_attempt_at, created_at
          LIMIT $3 FOR UPDATE OF outbox SKIP LOCKED
       ), classified AS MATERIALIZED (
         SELECT candidate.token_address, attribution.token_address IS NOT NULL AS exact
           FROM candidate LEFT JOIN robinhood_token_attributions attribution
             ON attribution.chain = '${CHAIN}'
            AND attribution.token_address = candidate.token_address
            AND attribution.source = ANY($4::varchar[])
            AND attribution.attribution_block IS NOT NULL
       ), removed AS (
         DELETE FROM robinhood_token_deployment_outbox outbox
          USING classified
          WHERE outbox.chain = '${CHAIN}'
            AND outbox.token_address = classified.token_address
            AND classified.exact
          RETURNING outbox.token_address
       ), claimed AS (
         UPDATE robinhood_token_deployment_outbox outbox
          SET status = 'leased', lease_owner = $1,
              lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              attempt_count = attempt_count + 1, updated_at = NOW()
         FROM classified WHERE outbox.chain = '${CHAIN}'
          AND outbox.token_address = classified.token_address
          AND NOT classified.exact
       RETURNING outbox.token_address, outbox.attempt_count, outbox.created_at,
                 outbox.live_deadline_at,
                 outbox.mint_block_number, outbox.mint_block_hash,
                 outbox.mint_transaction_hash
       )
       SELECT TRUE AS claimed, claimed.token_address, claimed.attempt_count,
              claimed.created_at, claimed.live_deadline_at,
              claimed.mint_block_number, claimed.mint_block_hash,
              claimed.mint_transaction_hash, block.block_timestamp AS mint_block_time
         FROM claimed LEFT JOIN robinhood_chain_blocks block
           ON block.chain = '${CHAIN}' AND block.block_hash = claimed.mint_block_hash
          AND block.canonical = TRUE
       UNION ALL
       SELECT FALSE, token_address, NULL::integer, NULL::timestamptz,
              NULL::timestamptz, NULL::bigint, NULL::varchar(66),
              NULL::varchar(66), NULL::timestamptz FROM removed`,
      [owner, leaseMs, limit, EXACT_SOURCES]
    );
    return Object.freeze({
      tasks: Object.freeze(rows.filter((row) => row.claimed).map(claimedTask)),
      removedExact: rows.filter((row) => !row.claimed).length,
    });
  }

  async function claimBatch(input = {}) {
    return (await claimBatchWithStats(input)).tasks;
  }

  async function claim(input = {}) {
    return (await claimBatch({ ...input, limit: 1 }))[0] || null;
  }

  async function archiveExpiredBatch(input = {}) {
    const limit = batchLimit(input.limit ?? 256);
    const result = await database.query(
      `WITH candidate AS (
         SELECT token_address FROM robinhood_token_deployment_outbox
          WHERE chain = '${CHAIN}' AND status = 'pending'
            AND live_deadline_at <= NOW()
          ORDER BY live_deadline_at, token_address
          LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE robinhood_token_deployment_outbox outbox
          SET status = 'archive_required', lease_owner = NULL, lease_until = NULL,
              archive_required_at = COALESCE(archive_required_at, NOW()), updated_at = NOW()
         FROM candidate WHERE outbox.chain = '${CHAIN}'
          AND outbox.token_address = candidate.token_address`,
      [limit]
    );
    return result.rowCount;
  }

  async function findMintHint(tokenAddress, input = {}) {
    const parsedConfirmations = input.confirmations == null ? 12 : Number(input.confirmations);
    const confirmations = Number.isSafeInteger(parsedConfirmations)
      ? Math.max(0, Math.min(parsedConfirmations, 1000)) : 12;
    const parsedLookback = input.lookbackBlocks == null ? 96 : Number(input.lookbackBlocks);
    const lookbackBlocks = Number.isSafeInteger(parsedLookback)
      ? Math.max(confirmations + 2, Math.min(parsedLookback, 1000)) : 96;
    const normalized = normalizeTokenAddress(CHAIN, tokenAddress);
    const { rows: bounds } = await database.query(
      `SELECT GREATEST(node_head - $1::bigint, 0)::text AS from_block,
              LEAST(checkpoint_block, GREATEST(node_head - $2::bigint, 0))::text
                AS through_block
         FROM robinhood_chain_capture_cursor WHERE chain='${CHAIN}'`,
      [lookbackBlocks, confirmations]
    );
    const { from_block: fromBlock, through_block: throughBlock } = bounds[0] || {};
    if (fromBlock == null || throughBlock == null
        || BigInt(fromBlock) > BigInt(throughBlock)) return null;
    const { rows } = await database.query(
      `SELECT event.block_number, event.block_hash, event.transaction_hash
         FROM robinhood_chain_events event
         INNER JOIN robinhood_chain_blocks block
           ON block.chain=event.chain AND block.block_hash=event.block_hash
          AND block.canonical=TRUE
        WHERE event.chain='${CHAIN}'
          AND event.address=$1 AND event.topic0=$2 AND event.topics->>1=$3
          AND event.block_number >= $4::bigint
          AND event.block_number <= $5::bigint
        ORDER BY event.block_number, event.transaction_index, event.log_index LIMIT 1`,
      [normalized, TRANSFER_TOPIC, ZERO_TOPIC, fromBlock, throughBlock]
    );
    return rows[0] ? Object.freeze({
      tokenAddress: normalized,
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

  async function completeRecovered(tokenAddress) {
    const result = await database.query(
      `DELETE FROM robinhood_token_deployment_outbox
        WHERE chain = '${CHAIN}' AND token_address = $1`,
      [normalizeTokenAddress(CHAIN, tokenAddress)]
    );
    return result.rowCount === 1;
  }

  async function completePinnedRecovered(hint) {
    const result = await database.query(
      `DELETE FROM robinhood_token_deployment_outbox
        WHERE chain = '${CHAIN}' AND token_address = $1
          AND status = 'archive_required'
          AND mint_block_number = $2::bigint
          AND mint_block_hash = $3 AND mint_transaction_hash = $4`,
      [normalizeTokenAddress(CHAIN, hint.tokenAddress),
        BigInt(String(hint.blockNumber)).toString(), hint.blockHash, hint.transactionHash]
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
    archiveExpiredBatch, claim, claimBatch, claimBatchWithStats, complete, completeRecovered,
    completePinnedRecovered,
    findDiscoveryHint, findMintHint, isExact, retry,
  });
}

module.exports = { createRobinhoodTokenDeploymentOutboxRepository };
