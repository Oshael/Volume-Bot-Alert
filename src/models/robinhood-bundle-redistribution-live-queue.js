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

const instant = (value) => (value == null ? null : new Date(value).toISOString());

function anchorMissing() {
  const error = new Error('redistribution queue durable anchor is missing');
  error.code = 'redistribution_anchor_missing';
  return error;
}

function assertedLineage(row, input) {
  if (!row.observation_from_hash || !row.observation_from_time
      || !row.source_through_block || !row.source_through_hash || !row.source_through_time
      || row.source_requested_version !== String(input.requestedVersion)) {
    throw anchorMissing();
  }
  const snapshot = input.snapshot.state;
  if (String(input.eventThroughBlock) !== row.event_through_block
      || BigInt(row.source_through_block) < BigInt(row.event_through_block)
      || String(input.observationFromBlock) !== row.observation_from_block
      || input.observationFromHash !== row.observation_from_hash
      || instant(input.observationFromTime) !== instant(row.observation_from_time)
      || String(snapshot.throughBlockNumber) !== row.source_through_block
      || snapshot.throughBlockHash !== row.source_through_hash
      || String(input.sourceThroughBlock) !== row.source_through_block
      || input.sourceThroughHash !== row.source_through_hash
      || instant(input.sourceThroughTime) !== instant(row.source_through_time)) {
    throw new Error('redistribution queue frozen frontier does not match snapshot lineage');
  }
  return row;
}

function createRobinhoodBundleRedistributionLiveQueueRepository(options = {}) {
  const database = options.database || db;
  const projectionFence = options.projectionFence;

  async function claimBatch(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('redistribution queue owner is invalid');
    const limit = bounded(input.limit, 10, 1, 100);
    const leaseMs = bounded(input.leaseMs, 300_000, 10_000, 1_200_000);
    const { rows } = await database.query(`WITH candidates AS MATERIALIZED (
      SELECT queue.chain, queue.token_address, queue.rule_version,
             queue.requested_version, queue.event_through_block,
             queue.source_through_block,
             queue.source_through_hash, queue.source_through_time,
             queue.source_requested_version, holder.ledger_status,
             holder.live_through_block, holder.live_through_hash,
             anchor.block_timestamp AS holder_anchor_time,
             canonical.block_timestamp AS canonical_time
      FROM robinhood_bundle_redistribution_queue queue
      INNER JOIN robinhood_bundle_redistribution_activations activation
        USING (chain, rule_version)
      LEFT JOIN robinhood_holder_token_states holder
        ON holder.chain = queue.chain AND holder.token_address = queue.token_address
      LEFT JOIN robinhood_chain_block_anchors anchor
        ON anchor.chain = holder.chain AND anchor.block_number = holder.live_through_block
       AND anchor.block_hash = holder.live_through_hash
      LEFT JOIN robinhood_chain_blocks canonical
        ON canonical.chain = holder.chain AND canonical.block_number = holder.live_through_block
       AND canonical.canonical
      WHERE queue.chain = $1 AND queue.rule_version = $2
        AND activation.status = 'active' AND queue.next_attempt_at <= NOW()
        AND (queue.status = 'pending'
          OR (queue.status = 'leased' AND queue.lease_until <= NOW()))
      ORDER BY queue.next_attempt_at, queue.updated_at
      LIMIT $3 FOR UPDATE OF queue SKIP LOCKED
    ), frozen AS MATERIALIZED (
      SELECT candidates.*,
        CASE
          WHEN source_requested_version = requested_version
            AND source_through_block >= event_through_block THEN source_through_block
          WHEN ledger_status = 'live' AND live_through_block IS NOT NULL
            AND live_through_block >= event_through_block
            AND live_through_hash ~ '^0x[0-9a-f]{64}$'
            AND (holder_anchor_time IS NOT NULL OR canonical_time IS NOT NULL)
          THEN live_through_block
        END AS frozen_block,
        CASE
          WHEN source_requested_version = requested_version
            AND source_through_block >= event_through_block THEN source_through_hash
          WHEN ledger_status = 'live' AND holder_anchor_time IS NOT NULL
            AND live_through_block >= event_through_block
          THEN live_through_hash
          WHEN ledger_status = 'live' AND live_through_block >= event_through_block
            AND canonical_time IS NOT NULL
          THEN capture_robinhood_chain_block_anchor(
            chain, live_through_block, live_through_hash
          )
        END AS frozen_hash,
        CASE
          WHEN source_requested_version = requested_version
            AND source_through_block >= event_through_block THEN source_through_time
          WHEN ledger_status = 'live' AND live_through_block >= event_through_block
          THEN COALESCE(holder_anchor_time, canonical_time)
        END AS frozen_time
      FROM candidates
    ) UPDATE robinhood_bundle_redistribution_queue queue SET
      status = 'leased', lease_owner = $4,
      lease_until = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
      attempt_count = attempt_count + 1, updated_at = NOW(),
      source_through_block = frozen.frozen_block,
      source_through_hash = frozen.frozen_hash,
      source_through_time = frozen.frozen_time,
      source_requested_version = CASE
        WHEN frozen.frozen_block IS NOT NULL AND frozen.frozen_hash IS NOT NULL
          AND frozen.frozen_time IS NOT NULL THEN frozen.requested_version
      END
    FROM frozen WHERE queue.chain = frozen.chain
      AND queue.token_address = frozen.token_address
      AND queue.rule_version = frozen.rule_version
    RETURNING queue.token_address, queue.observation_from_block::text,
      queue.observation_from_hash, queue.observation_from_time,
      queue.event_through_block::text, queue.requested_version::text,
      queue.source_through_block::text, queue.source_through_hash,
      queue.source_through_time, queue.source_requested_version::text,
      queue.attempt_count`, [CHAIN, RULE_VERSION, limit, owner, leaseMs]);
    return Object.freeze(rows.map((row) => Object.freeze({
      tokenAddress: row.token_address,
      observationFromBlock: row.observation_from_block,
      observationFromHash: row.observation_from_hash,
      observationFromTime: instant(row.observation_from_time),
      eventThroughBlock: row.event_through_block,
      requestedVersion: row.requested_version,
      sourceThroughBlock: row.source_through_block,
      sourceThroughHash: row.source_through_hash,
      sourceThroughTime: instant(row.source_through_time),
      sourceRequestedVersion: row.source_requested_version,
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
      const locked = await client.query(`SELECT requested_version::text,
          event_through_block::text,
          observation_from_block::text,
          observation_from_hash, observation_from_time,
          source_through_block::text, source_through_hash, source_through_time,
          source_requested_version::text
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
      assertedLineage(locked.rows[0], input);
      const snapshot = await replaceRedistributionSnapshotWithClient(
        client, input.snapshot, new Date().toISOString(), { projectionFence }
      );
      const completed = await client.query(`UPDATE robinhood_bundle_redistribution_queue SET
        status = 'complete', completed_version = requested_version,
        lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
        last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE chain = $1 AND token_address = $2 AND rule_version = $3
          AND status = 'leased' AND lease_owner = $4
          AND requested_version = $5::bigint
          AND source_requested_version = $5::bigint
          AND source_through_block = $6::bigint AND source_through_hash = $7`, [
        CHAIN, tokenAddress, RULE_VERSION, input.owner, input.requestedVersion,
        input.sourceThroughBlock, input.sourceThroughHash,
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

module.exports = { createRobinhoodBundleRedistributionLiveQueueRepository,
  __private: { assertedLineage } };
