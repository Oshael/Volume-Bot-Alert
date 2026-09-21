'use strict';

const db = require('../models/db');
const { CLASSIFICATION_VERSION } = require('./robinhood-wallet-transfer-batch');

const CHAIN = 'robinhood';
const DEFAULT_RETENTION_BLOCKS = 20_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_LAG = 2n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CLASSIFICATION_DEPENDENCIES = ['funding', 'deployment', 'redistribution'];

function quantity(value) { return value == null ? null : BigInt(value); }
function text(value) { return value == null ? null : String(value); }
function subtractFloor(value, retained) {
  return value == null ? null : value > retained ? value - retained : 0n;
}
function minimum(values) {
  const present = values.filter((value) => value != null);
  return present.length ? present.reduce((left, right) => left < right ? left : right) : null;
}
function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(detail == null ? { code } : { code, detail });
}
function validRetentionBlocks(value, label) {
  const parsed = Number(value ?? DEFAULT_RETENTION_BLOCKS);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000_000) {
    throw new Error(`${label} must be between 1 and 10000000`);
  }
  return BigInt(parsed);
}

function cursor(row, name, required = true) {
  const next = quantity(row[`${name}_next_block`]);
  const checkpoint = quantity(row[`${name}_checkpoint_block`]);
  const checkpointHash = row[`${name}_checkpoint_hash`] || null;
  const canonicalHash = row[`${name}_canonical_hash`] || null;
  return Object.freeze({
    name, required, next, checkpoint,
    valid: next != null && checkpoint != null && next === checkpoint + 1n
      && checkpointHash != null && checkpointHash === canonicalHash,
  });
}

function sharedBlockers({ captureNext, captureHead, captureLag }) {
  const blockers = [];
  add(blockers, captureNext == null || captureHead == null, 'capture_frontier_missing');
  add(blockers, captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  return blockers;
}

function holderRisks(row, holderCutoff) {
  const blockers = [];
  add(blockers, row.holder_mint_proof_skipped === true, 'holder_mint_proof_not_requested');
  add(blockers, row.global_run_id != null, 'holder_global_backfill_active', {
    run_id: text(row.global_run_id), status: row.global_run_status,
    next_block: text(row.global_run_next_block),
  });
  const oldPending = quantity(row.oldest_unapplied_holder_block);
  add(blockers, oldPending != null && holderCutoff != null && oldPending < holderCutoff,
    'unapplied_holder_event_before_cutoff', text(oldPending));
  const mintRisk = quantity(row.oldest_pending_deployment_mint_block);
  add(blockers, mintRisk != null && holderCutoff != null && mintRisk < holderCutoff,
    'deployment_mint_hint_before_cutoff', text(mintRisk));
  return { blockers, oldPending, mintRisk };
}

function classificationRisks(rows = []) {
  const byName = new Map(rows.map((row) => [row.dependency, row]));
  const dependencies = Object.fromEntries(CLASSIFICATION_DEPENDENCIES.map((name) => {
    const row = byName.get(name) || {};
    const counts = Object.fromEntries(['items', 'safe', 'at_risk', 'archive_required', 'blocked']
      .map((key) => [key, Number(row[key] || 0)]));
    const status = counts.blocked ? 'blocked'
      : counts.archive_required ? 'archive_required' : counts.at_risk ? 'at_risk' : 'safe';
    return [name, Object.freeze({ status, ...counts,
      oldest_age_s: row.oldest_age_s == null ? null : String(row.oldest_age_s) })];
  }));
  const values = Object.values(dependencies);
  const status = values.some((item) => item.status === 'blocked') ? 'blocked'
    : values.some((item) => item.status === 'archive_required') ? 'archive_required'
      : values.some((item) => item.status === 'at_risk') ? 'at_risk' : 'safe';
  return Object.freeze({ status, warning_after_s: 48 * 60 * 60,
    archive_after_s: 72 * 60 * 60, dependencies });
}

async function loadClassificationRisks(client) {
  const result = await client.query(`/* retention-safety:wallet-classification */
    WITH funding AS (
      SELECT 'funding'::text AS dependency,
        CASE WHEN queue.last_error_code='archive_required' OR raw.block_number IS NULL
               OR raw.block_timestamp <= NOW() - INTERVAL '72 hours' THEN 'archive_required'
             WHEN raw.block_timestamp <= NOW() - INTERVAL '48 hours' THEN 'at_risk'
             ELSE 'safe' END AS severity,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(raw.block_timestamp, queue.created_at)))::bigint age_s
      FROM robinhood_bundle_funding_live_queue queue
      LEFT JOIN robinhood_chain_blocks raw ON raw.chain=queue.chain AND raw.canonical
        AND raw.block_number=GREATEST(queue.anchor_block - queue.lookback_blocks, 0)
      WHERE queue.chain=$1 AND (queue.status<>'complete'
        OR queue.last_error_code='archive_required')
    ), deployment AS (
      SELECT 'deployment'::text AS dependency,
        CASE WHEN task.status='archive_required' THEN 'archive_required'
             WHEN task.mint_block_number IS NOT NULL AND raw.block_number IS NULL
               THEN 'archive_required'
             WHEN COALESCE(raw.block_timestamp, task.created_at)
               <= NOW() - INTERVAL '72 hours' THEN 'archive_required'
             WHEN COALESCE(raw.block_timestamp, task.created_at)
               <= NOW() - INTERVAL '48 hours' THEN 'at_risk'
             ELSE 'safe' END AS severity,
        EXTRACT(EPOCH FROM (NOW()
          - COALESCE(raw.block_timestamp, task.created_at)))::bigint age_s
      FROM robinhood_token_deployment_outbox task
      LEFT JOIN robinhood_chain_blocks raw ON raw.chain=task.chain AND raw.canonical
        AND raw.block_number=task.mint_block_number
      WHERE task.chain=$1
    ), redistribution_inputs AS (
      SELECT queue.*, observation_raw.block_hash AS observation_canonical_hash,
        observation_raw.block_timestamp AS observation_raw_time,
        source_raw.block_hash AS source_canonical_hash,
        holder.ledger_status, holder.live_through_block, holder.live_through_hash,
        holder_raw.block_hash AS holder_canonical_hash,
        holder_raw.block_timestamp AS holder_raw_time,
        holder_anchor.block_number AS holder_anchor_block
      FROM robinhood_bundle_redistribution_queue queue
      LEFT JOIN robinhood_chain_blocks observation_raw ON observation_raw.chain=queue.chain
        AND observation_raw.canonical
        AND observation_raw.block_number=queue.observation_from_block
      LEFT JOIN robinhood_chain_blocks source_raw ON source_raw.chain=queue.chain
        AND source_raw.canonical AND source_raw.block_number=queue.source_through_block
      LEFT JOIN robinhood_holder_token_states holder ON holder.chain=queue.chain
        AND holder.token_address=queue.token_address
      LEFT JOIN robinhood_chain_blocks holder_raw ON holder_raw.chain=holder.chain
        AND holder_raw.canonical AND holder_raw.block_number=holder.live_through_block
      LEFT JOIN robinhood_chain_block_anchors holder_anchor ON holder_anchor.chain=holder.chain
        AND holder_anchor.block_number=holder.live_through_block
        AND holder_anchor.block_hash=holder.live_through_hash
      WHERE queue.chain=$1 AND queue.status<>'complete'
        AND (queue.observation_from_hash IS NULL
          OR queue.source_requested_version IS DISTINCT FROM queue.requested_version)
    ), redistribution AS (
      SELECT 'redistribution'::text AS dependency,
        CASE WHEN (observation_from_hash IS NOT NULL AND observation_canonical_hash IS NOT NULL
                    AND observation_from_hash<>observation_canonical_hash)
               OR (source_requested_version=requested_version AND source_canonical_hash IS NOT NULL
                    AND source_through_hash<>source_canonical_hash)
               OR (ledger_status='live' AND live_through_block>=event_through_block
                    AND holder_canonical_hash IS NOT NULL
                    AND live_through_hash<>holder_canonical_hash) THEN 'blocked'
             WHEN observation_from_hash IS NULL AND observation_raw_time IS NULL
               THEN 'archive_required'
             WHEN observation_from_hash IS NULL
               AND observation_raw_time <= NOW() - INTERVAL '72 hours' THEN 'archive_required'
             WHEN source_requested_version IS DISTINCT FROM requested_version
               AND ledger_status='live' AND live_through_block>=event_through_block
               AND holder_anchor_block IS NULL AND holder_raw_time IS NULL THEN 'archive_required'
             WHEN source_requested_version IS DISTINCT FROM requested_version
               AND ledger_status='live' AND live_through_block>=event_through_block
               AND holder_anchor_block IS NULL
               AND holder_raw_time <= NOW() - INTERVAL '72 hours' THEN 'archive_required'
             WHEN (observation_from_hash IS NULL
                    AND observation_raw_time <= NOW() - INTERVAL '48 hours')
               OR (source_requested_version IS DISTINCT FROM requested_version
                   AND ledger_status='live' AND live_through_block>=event_through_block
                   AND holder_anchor_block IS NULL
                   AND holder_raw_time <= NOW() - INTERVAL '48 hours') THEN 'at_risk'
             ELSE 'safe' END AS severity,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(observation_raw_time,
          holder_raw_time, created_at)))::bigint age_s
      FROM redistribution_inputs
    ), risks AS (
      SELECT * FROM funding UNION ALL SELECT * FROM deployment
      UNION ALL SELECT * FROM redistribution
    ), dependencies(dependency) AS (
      VALUES ('funding'::text), ('deployment'::text), ('redistribution'::text)
    )
    SELECT dependencies.dependency, COUNT(risks.severity)::int AS items,
      COUNT(*) FILTER (WHERE risks.severity='safe')::int AS safe,
      COUNT(*) FILTER (WHERE risks.severity='at_risk')::int AS at_risk,
      COUNT(*) FILTER (WHERE risks.severity='archive_required')::int AS archive_required,
      COUNT(*) FILTER (WHERE risks.severity='blocked')::int AS blocked,
      MAX(risks.age_s)::text AS oldest_age_s
    FROM dependencies LEFT JOIN risks USING (dependency)
    GROUP BY dependencies.dependency ORDER BY dependencies.dependency`, [CHAIN]);
  return result.rows;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const chainRetained = validRetentionBlocks(input.chainRetentionBlocks, 'chainRetentionBlocks');
  const holderRetained = validRetentionBlocks(input.holderRetentionBlocks, 'holderRetentionBlocks');
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const captureLag = captureNext == null || captureHead == null || captureNext > captureHead
    ? 0n : captureHead - captureNext + 1n;
  const consumers = [
    cursor(row, 'liquidity'), cursor(row, 'holder'), cursor(row, 'creator'),
    cursor(row, 'transfer'),
  ];
  const outboxFirst = quantity(row.outbox_first_unsettled);
  const liquidityDirty = quantity(row.liquidity_dirty_from_block);
  const sourceFrontier = minimum([
    ...consumers.map((item) => item.next),
    outboxFirst == null ? captureNext : outboxFirst,
    liquidityDirty == null ? captureNext : liquidityDirty,
  ]);
  const chainCutoff = subtractFloor(sourceFrontier, chainRetained);
  const holderCursor = consumers.find(({ name }) => name === 'holder');
  const holderCutoff = subtractFloor(holderCursor.next, holderRetained);
  const journalStart = quantity(row.journal_start_block);
  const holderFloor = quantity(row.holder_journal_floor_block);
  const common = sharedBlockers({ captureNext, captureHead, captureLag });
  const classification = classificationRisks(input.classification);

  const chainBlockers = [...common];
  for (const item of consumers) {
    add(chainBlockers, item.required && !item.valid, 'consumer_checkpoint_invalid', item.name);
  }
  add(chainBlockers, journalStart == null, 'canonical_journal_empty');
  add(chainBlockers, chainCutoff == null || journalStart == null || chainCutoff <= journalStart,
    'no_chain_event_prefix_eligible');
  add(chainBlockers, Object.values(classification.dependencies)
    .some((item) => item.archive_required > 0),
  'wallet_classification_archive_required');
  add(chainBlockers, Object.values(classification.dependencies)
    .some((item) => item.blocked > 0), 'wallet_classification_retention_blocked');

  const holderBlockers = [...common];
  add(holderBlockers, !holderCursor.valid, 'holder_checkpoint_invalid');
  add(holderBlockers, holderFloor == null, 'holder_journal_floor_uninitialized');
  add(holderBlockers, holderCutoff == null || holderFloor == null || holderCutoff <= holderFloor,
    'no_holder_journal_prefix_eligible');
  const risks = holderRisks(row, holderCutoff);
  holderBlockers.push(...risks.blockers);

  return Object.freeze({
    mode: 'read-only', action: 'none',
    ready_for_pilot: chainBlockers.length === 0 && holderBlockers.length === 0,
    chain_events: {
      ready_for_pilot: chainBlockers.length === 0, blockers: chainBlockers,
      journal_start_block: text(journalStart), candidate_cutoff_block: text(chainCutoff),
      retained_blocks: text(chainRetained), source_frontier_block: text(sourceFrontier),
      relation_bytes: text(row.chain_events_bytes),
      consumers: Object.fromEntries(consumers.map((item) => [item.name, {
        next_block: text(item.next), checkpoint_block: text(item.checkpoint),
        checkpoint_canonical: item.valid,
      }])),
      first_unsettled_outbox_block: text(outboxFirst),
      first_pending_liquidity_refresh_block: text(liquidityDirty),
      quarantined_liquidity_refreshes: text(row.liquidity_quarantined_count),
      cascade_tables: ['robinhood_chain_domain_outbox',
        'robinhood_canonical_head_candidates', 'robinhood_chain_v3_balance_snapshots'],
    },
    holder_journal: {
      ready_for_pilot: holderBlockers.length === 0, blockers: holderBlockers,
      journal_floor_block: text(holderFloor), candidate_cutoff_block: text(holderCutoff),
      retained_blocks: text(holderRetained), relation_bytes: text(row.holder_journal_bytes),
      oldest_unapplied_block: text(risks.oldPending),
      oldest_pending_deployment_mint_block: text(risks.mintRisk),
    },
    wallet_classification: classification,
    proof: {
      scope: 'durable_consumer_checkpoints_and_downstream_materialization_gates',
      holder_atomicity: 'balances_token_state_and_applied_marker_commit_together',
      limitation: 'proves committed materialization, not independent semantic replay',
    },
  });
}

function createRobinhoodRetentionSafetyAudit(options = {}) {
  const database = options.database || db;
  const includeHolderProof = options.includeHolderProof !== false;
  const chainRetentionBlocks = Number(options.chainRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS);
  const holderRetentionBlocks = Number(options.holderRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS);
  async function inspect() {
    const client = await database.getClient();
    let state; let classification;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${DEFAULT_STATEMENT_TIMEOUT_MS}ms'`);
      state = (await client.query(
        `/* retention-safety:state */ SELECT capture.next_block AS capture_next_block,
                capture.node_head AS capture_node_head,
                journal.block_number AS journal_start_block,
                liquidity.next_block AS liquidity_next_block,
                liquidity.checkpoint_block AS liquidity_checkpoint_block,
                liquidity.checkpoint_hash AS liquidity_checkpoint_hash,
                liquidity_hash.block_hash AS liquidity_canonical_hash,
                holder.next_block AS holder_next_block,
                holder.checkpoint_block AS holder_checkpoint_block,
                holder.checkpoint_hash AS holder_checkpoint_hash,
                holder_hash.block_hash AS holder_canonical_hash,
                holder.journal_floor_block AS holder_journal_floor_block,
                creator.next_block AS creator_next_block,
                creator.checkpoint_block AS creator_checkpoint_block,
                creator.checkpoint_hash AS creator_checkpoint_hash,
                creator_hash.block_hash AS creator_canonical_hash,
                transfer.next_block AS transfer_next_block,
                transfer.checkpoint_block AS transfer_checkpoint_block,
                transfer.checkpoint_hash AS transfer_checkpoint_hash,
                transfer_hash.block_hash AS transfer_canonical_hash,
                outbox.block_number AS outbox_first_unsettled,
                refresh.dirty_from_block AS liquidity_dirty_from_block,
                refresh.quarantined_count AS liquidity_quarantined_count,
                pending.block_number AS oldest_unapplied_holder_block,
                campaign.id AS global_run_id, campaign.status AS global_run_status,
                campaign.next_block AS global_run_next_block,
                pg_total_relation_size('robinhood_chain_events') AS chain_events_bytes,
                pg_total_relation_size('robinhood_holder_transfer_journal') AS holder_journal_bytes
           FROM (VALUES (1)) anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN LATERAL (SELECT event.block_number FROM robinhood_chain_events event
             JOIN robinhood_chain_blocks block ON block.chain=event.chain
              AND block.block_hash=event.block_hash AND block.canonical
             WHERE event.chain=$1 ORDER BY event.block_number LIMIT 1) journal ON TRUE
           LEFT JOIN robinhood_pool_liquidity_event_cursors liquidity ON liquidity.chain=$1
           LEFT JOIN robinhood_holder_cursors holder ON holder.chain=$1 AND holder.stream='live'
           LEFT JOIN robinhood_direct_creator_cursors creator
             ON creator.chain=$1 AND creator.stream='live'
           LEFT JOIN robinhood_wallet_transfer_cursors transfer ON transfer.chain=$1
             AND transfer.projection_version=$2 AND transfer.stream='live'
           LEFT JOIN robinhood_chain_blocks liquidity_hash ON liquidity_hash.chain=$1
             AND liquidity_hash.canonical AND liquidity_hash.block_number=liquidity.checkpoint_block
           LEFT JOIN robinhood_chain_blocks holder_hash ON holder_hash.chain=$1
             AND holder_hash.canonical AND holder_hash.block_number=holder.checkpoint_block
           LEFT JOIN robinhood_chain_blocks creator_hash ON creator_hash.chain=$1
             AND creator_hash.canonical AND creator_hash.block_number=creator.checkpoint_block
           LEFT JOIN robinhood_chain_blocks transfer_hash ON transfer_hash.chain=$1
             AND transfer_hash.canonical AND transfer_hash.block_number=transfer.checkpoint_block
           LEFT JOIN LATERAL (SELECT block_number FROM robinhood_chain_domain_outbox
             WHERE chain=$1 AND status<>'complete' ORDER BY block_number LIMIT 1) outbox ON TRUE
           LEFT JOIN LATERAL (
             SELECT MIN(dirty_from_block) FILTER (WHERE status<>'quarantined')
                      AS dirty_from_block,
                    COUNT(*) FILTER (WHERE status='quarantined') AS quarantined_count
             FROM robinhood_pool_liquidity_refresh_queue WHERE chain=$1
           ) refresh ON TRUE
           LEFT JOIN LATERAL (SELECT block_number FROM robinhood_holder_transfer_journal
             WHERE chain=$1 AND applied=FALSE ORDER BY block_number LIMIT 1) pending ON TRUE
           LEFT JOIN LATERAL (SELECT id, status, next_block
             FROM robinhood_holder_global_backfill_runs WHERE chain=$1 AND status<>'completed'
             ORDER BY id DESC LIMIT 1) campaign ON TRUE`,
        [CHAIN, CLASSIFICATION_VERSION]
      )).rows[0] || {};
      classification = await loadClassificationRisks(client);
      // An active global campaign already blocks holder retention. Avoid an
      // expensive journal proof whose result cannot change that decision.
      if (includeHolderProof && state.global_run_id == null) {
        const mint = await client.query(
          `/* retention-safety:mint */ SELECT MIN(journal.block_number) AS block_number
             FROM robinhood_holder_transfer_journal journal
            WHERE journal.chain=$1 AND journal.from_wallet=$2
              AND EXISTS (
                SELECT 1 FROM robinhood_token_deployment_outbox task
                 WHERE task.chain=journal.chain
                   AND task.token_address=journal.token_address
              )`,
          [CHAIN, ZERO_ADDRESS]
        );
        state.oldest_pending_deployment_mint_block = mint.rows[0]?.block_number ?? null;
      } else {
        state.oldest_pending_deployment_mint_block = null;
        state.holder_mint_proof_skipped = !includeHolderProof;
      }
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
    return evaluate({ state, classification, chainRetentionBlocks, holderRetentionBlocks });
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_RETENTION_BLOCKS, DEFAULT_STATEMENT_TIMEOUT_MS,
  createRobinhoodRetentionSafetyAudit, evaluate, loadClassificationRisks,
};
