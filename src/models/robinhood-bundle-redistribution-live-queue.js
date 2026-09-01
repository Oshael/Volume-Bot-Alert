const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { RULE_VERSION } = require('../utils/db-init-stage188');
const {
  replaceRedistributionSnapshotWithClient,
} = require('./robinhood-bundle-redistribution-snapshot');

const CHAIN = 'robinhood';
const bounded = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};

function createRobinhoodBundleRedistributionLiveQueueRepository(options = {}) {
  const database = options.database || db;

  async function claimBatch(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('redistribution queue owner is invalid');
    const limit = bounded(input.limit, 10, 1, 100);
    const leaseMs = bounded(input.leaseMs, 300_000, 10_000, 1_200_000);
    const { rows } = await database.query(`WITH candidates AS MATERIALIZED (
      SELECT queue.chain, queue.token_address, queue.rule_version
      FROM robinhood_bundle_redistribution_queue queue
      INNER JOIN robinhood_bundle_redistribution_activations activation
        USING (chain, rule_version)
      WHERE queue.chain = $1 AND queue.rule_version = $2
        AND activation.status = 'active' AND queue.next_attempt_at <= NOW()
        AND (queue.status = 'pending'
          OR (queue.status = 'leased' AND queue.lease_until <= NOW()))
      ORDER BY queue.next_attempt_at, queue.updated_at
      LIMIT $3 FOR UPDATE OF queue SKIP LOCKED
    ) UPDATE robinhood_bundle_redistribution_queue queue SET
      status = 'leased', lease_owner = $4,
      lease_until = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
      attempt_count = attempt_count + 1, updated_at = NOW()
    FROM candidates WHERE queue.chain = candidates.chain
      AND queue.token_address = candidates.token_address
      AND queue.rule_version = candidates.rule_version
    RETURNING queue.token_address, queue.observation_from_block::text,
      queue.event_through_block::text, queue.requested_version::text,
      queue.attempt_count`, [CHAIN, RULE_VERSION, limit, owner, leaseMs]);
    return Object.freeze(rows.map((row) => Object.freeze({
      tokenAddress: row.token_address,
      observationFromBlock: row.observation_from_block,
      eventThroughBlock: row.event_through_block,
      requestedVersion: row.requested_version,
      attemptCount: Number(row.attempt_count),
    })));
  }

  async function retry(input = {}) {
    const retryMs = bounded(input.retryMs, 15_000, 1000, 86_400_000);
    const result = await database.query(`UPDATE robinhood_bundle_redistribution_queue SET
      status = 'pending', lease_owner = NULL, lease_until = NULL,
      next_attempt_at = NOW() + ($6::bigint * INTERVAL '1 millisecond'),
      last_error_code = $7, last_error_message = $8, updated_at = NOW()
      WHERE chain = $1 AND token_address = $2 AND rule_version = $3
        AND status = 'leased' AND lease_owner = $4
        AND requested_version = $5::bigint`, [
      CHAIN, normalizeTokenAddress(CHAIN, input.tokenAddress), RULE_VERSION,
      input.owner, input.requestedVersion, retryMs,
      String(input.error?.code || 'redistribution_live_error').slice(0, 64),
      String(input.error?.message || input.error || 'redistribution LIVE failed').slice(0, 500),
    ]);
    return result.rowCount === 1;
  }

  async function replaceSnapshotAndComplete(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    if (input.snapshot?.state?.sourceKind !== 'live'
        || input.snapshot.state.tokenAddress !== tokenAddress
        || String(input.snapshot.state.sourceVersion) !== String(input.requestedVersion)) {
      throw new Error('redistribution LIVE snapshot lineage is invalid');
    }
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT requested_version::text
        FROM robinhood_bundle_redistribution_queue
        WHERE chain = $1 AND token_address = $2 AND rule_version = $3
          AND status = 'leased' AND lease_owner = $4
          AND requested_version = $5::bigint FOR UPDATE`, [
        CHAIN, tokenAddress, RULE_VERSION, input.owner, input.requestedVersion,
      ]);
      if (!locked.rowCount) {
        await client.query('ROLLBACK');
        return Object.freeze({ completed: false, snapshot: null });
      }
      const snapshot = await replaceRedistributionSnapshotWithClient(
        client, input.snapshot, new Date().toISOString()
      );
      const completed = await client.query(`UPDATE robinhood_bundle_redistribution_queue SET
        status = 'complete', completed_version = requested_version,
        lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
        last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE chain = $1 AND token_address = $2 AND rule_version = $3
          AND status = 'leased' AND lease_owner = $4
          AND requested_version = $5::bigint`, [
        CHAIN, tokenAddress, RULE_VERSION, input.owner, input.requestedVersion,
      ]);
      if (completed.rowCount !== 1) throw new Error('redistribution queue lease changed');
      await client.query('COMMIT');
      return Object.freeze({ completed: true, snapshot });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ claimBatch, replaceSnapshotAndComplete, retry });
}

module.exports = { createRobinhoodBundleRedistributionLiveQueueRepository };
