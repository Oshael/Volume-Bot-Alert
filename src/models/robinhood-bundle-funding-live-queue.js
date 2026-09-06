const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { replaceSnapshotWithClient } = require('./robinhood-possible-bundle-snapshot');

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

  async function preserveEvidenceAndComplete(input = {}) {
    const result = await database.query(`UPDATE robinhood_bundle_funding_live_queue SET
      status = 'complete', completed_version = requested_version,
      lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
      next_attempt_at = NOW(), last_error_code = 'archive_required',
      last_error_message = $5, updated_at = NOW()
      WHERE chain = $1 AND token_address = $2 AND status = 'leased'
        AND lease_owner = $3 AND requested_version = $4::bigint`, [
      CHAIN, token(input.tokenAddress), input.owner, input.requestedVersion,
      String(input.message || 'historical evidence preserved; Archive repair required').slice(0, 500),
    ]);
    return result.rowCount === 1;
  }

  async function replaceEvidenceAndComplete(input = {}) {
    if (!Array.isArray(input.evidence)) throw new Error('live funding evidence is required');
    if (!input.snapshot) throw new Error('live possible bundle snapshot is required');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT token_address, rule_version, evidence_version,
               requested_version::text, source_through_block::text, lookback_blocks::text
          FROM robinhood_bundle_funding_live_queue
        WHERE chain = $1 AND token_address = $2 AND status = 'leased'
          AND lease_owner = $3 AND requested_version = $4::bigint FOR UPDATE`,
      [CHAIN, token(input.tokenAddress), input.owner, input.requestedVersion]);
      if (!locked.rowCount) { await client.query('ROLLBACK'); return false; }
      await client.query(`DELETE FROM robinhood_bundle_funding_live_evidence
        WHERE chain = $1 AND token_address = $2`, [CHAIN, token(input.tokenAddress)]);
      if (input.evidence.length) {
        await client.query(`INSERT INTO robinhood_bundle_funding_live_evidence(
          chain, token_address, queue_version, candidate_wallet, hop, block_number,
          block_hash, block_time, transaction_hash, transaction_index,
          from_wallet, to_wallet, value_wei
        ) SELECT $1, $2, $3::bigint, item.candidate_wallet, item.hop::smallint,
                 item.block_number::bigint, item.block_hash, item.block_time::timestamptz,
                 item.transaction_hash, item.transaction_index::integer,
                 item.from_wallet, item.to_wallet, item.value_wei::numeric
            FROM jsonb_to_recordset($4::jsonb) AS item(
              candidate_wallet text, hop integer, block_number text, block_hash text,
              block_time text, transaction_hash text, transaction_index text,
              from_wallet text, to_wallet text, value_wei text)`, [
          CHAIN, token(input.tokenAddress), input.requestedVersion,
          JSON.stringify(input.evidence.map((item) => ({
            candidate_wallet: item.candidateWallet, hop: item.hop,
            block_number: item.blockNumber, block_hash: item.blockHash,
            block_time: item.blockTime, transaction_hash: item.transactionHash,
            transaction_index: item.transactionIndex, from_wallet: item.fromAddress,
            to_wallet: item.toAddress, value_wei: item.valueWei,
          }))),
        ]);
      }
      const snapshotResult = await replaceSnapshotWithClient(
        client, input.snapshot, locked.rows[0], new Date().toISOString()
      );
      await client.query(`UPDATE robinhood_bundle_funding_live_queue SET
        status = 'complete', completed_version = requested_version,
        lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
        last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE chain = $1 AND token_address = $2`, [CHAIN, token(input.tokenAddress)]);
      await client.query('COMMIT');
      return Object.freeze({ completed: true, snapshot: snapshotResult });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({
    claim, complete, preserveEvidenceAndComplete, retry, replaceEvidenceAndComplete,
  });
}

module.exports = { createRobinhoodBundleFundingLiveQueueRepository };
