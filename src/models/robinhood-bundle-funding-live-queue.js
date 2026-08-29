const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const token = (value) => normalizeTokenAddress(CHAIN, value);

function createRobinhoodBundleFundingLiveQueueRepository(options = {}) {
  const database = options.database || db;

  async function claim(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('funding queue owner is invalid');
    const leaseMs = Math.max(10_000, Math.min(Number(input.leaseMs) || 300_000, 1_200_000));
    const { rows } = await database.query(`WITH candidate AS (
      SELECT token_address FROM robinhood_bundle_funding_live_queue
       WHERE chain = $1 AND (status = 'pending' OR lease_until <= NOW())
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at, updated_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE robinhood_bundle_funding_live_queue queue SET
        status = 'leased', lease_owner = $2,
        lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
        attempt_count = attempt_count + 1, updated_at = NOW()
       FROM candidate WHERE queue.chain = $1
        AND queue.token_address = candidate.token_address
      RETURNING queue.token_address, queue.requested_version::text,
                queue.anchor_block::text, queue.source_through_block::text,
                queue.lookback_blocks::text, queue.attempt_count`,
    [CHAIN, owner, leaseMs]);
    const row = rows[0];
    return row ? Object.freeze({
      tokenAddress: row.token_address, requestedVersion: row.requested_version,
      anchorBlock: row.anchor_block, sourceThroughBlock: row.source_through_block,
      lookbackBlocks: row.lookback_blocks, attemptCount: Number(row.attempt_count),
    }) : null;
  }

  async function complete(input = {}) {
    const result = await database.query(`UPDATE robinhood_bundle_funding_live_queue SET
      status = 'complete', completed_version = $4::bigint,
      lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
      last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
      WHERE chain = $1 AND token_address = $2 AND status = 'leased'
        AND lease_owner = $3 AND requested_version = $4::bigint`,
    [CHAIN, token(input.tokenAddress), input.owner, input.requestedVersion]);
    return result.rowCount === 1;
  }

  async function retry(input = {}) {
    const retryMs = Math.max(1000, Math.min(Number(input.retryMs) || 15_000, 86_400_000));
    const result = await database.query(`UPDATE robinhood_bundle_funding_live_queue SET
      status = 'pending', lease_owner = NULL, lease_until = NULL,
      next_attempt_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
      last_error_code = $6, last_error_message = $7, updated_at = NOW()
      WHERE chain = $1 AND token_address = $2 AND status = 'leased'
        AND lease_owner = $3 AND requested_version = $4::bigint`, [
      CHAIN, token(input.tokenAddress), input.owner, input.requestedVersion, retryMs,
      String(input.error?.code || 'funding_live_failed').slice(0, 64),
      String(input.error?.message || input.error || 'funding live failed').slice(0, 500),
    ]);
    return result.rowCount === 1;
  }

  return Object.freeze({ claim, complete, retry });
}

module.exports = { createRobinhoodBundleFundingLiveQueueRepository };
