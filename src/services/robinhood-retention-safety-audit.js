'use strict';

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { CLASSIFICATION_VERSION } = require('./robinhood-wallet-transfer-batch');

const CHAIN = 'robinhood';
const DEFAULT_RETENTION_BLOCKS = 20_000;
const MAX_CAPTURE_LAG = 2n;

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

function sharedBlockers({ captureNext, captureHead, captureLag, archive }) {
  const blockers = [];
  add(blockers, captureNext == null || captureHead == null, 'capture_frontier_missing');
  add(blockers, captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(blockers, !archive.configured, 'archive_rpc_unconfigured');
  add(blockers, archive.configured && !archive.ready, 'archive_receipt_probe_failed',
    archive.error || archive.samples);
  return blockers;
}

function holderRisks(row, holderCutoff) {
  const blockers = [];
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
  const sourceFrontier = minimum([
    ...consumers.map((item) => item.next), outboxFirst == null ? captureNext : outboxFirst,
  ]);
  const chainCutoff = subtractFloor(sourceFrontier, chainRetained);
  const holderCursor = consumers.find(({ name }) => name === 'holder');
  const holderCutoff = subtractFloor(holderCursor.next, holderRetained);
  const journalStart = quantity(row.journal_start_block);
  const holderFloor = quantity(row.holder_journal_floor_block);
  const archive = input.archive || { configured: false, ready: false, samples: [] };
  const common = sharedBlockers({ captureNext, captureHead, captureLag, archive });

  const chainBlockers = [...common];
  for (const item of consumers) {
    add(chainBlockers, item.required && !item.valid, 'consumer_checkpoint_invalid', item.name);
  }
  add(chainBlockers, journalStart == null, 'canonical_journal_empty');
  add(chainBlockers, chainCutoff == null || journalStart == null || chainCutoff <= journalStart,
    'no_chain_event_prefix_eligible');

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
    archive,
    proof: {
      scope: 'consumer_checkpoints_plus_sampled_archive_receipts',
      limitation: 'sampled archive verification does not prove every historical block',
    },
  });
}

async function probeArchive(samples, rpcClient) {
  if (!rpcClient) return Object.freeze({ configured: false, ready: false, samples: [] });
  try {
    const checked = await Promise.all(samples.map(async (sample) => {
      const tag = `0x${BigInt(sample.block_number).toString(16)}`;
      const [block, receipts] = await Promise.all([
        rpcClient.request('eth_getBlockByNumber', [tag, false]),
        rpcClient.request('eth_getBlockReceipts', [tag]),
      ]);
      const receiptLogs = Array.isArray(receipts)
        ? receipts.reduce((total, receipt) => total + (receipt.logs?.length || 0), 0) : null;
      const ready = block?.hash?.toLowerCase() === sample.block_hash.toLowerCase()
        && receiptLogs === Number(sample.event_count);
      return { block_number: text(sample.block_number), block_hash: sample.block_hash,
        local_events: Number(sample.event_count), archive_events: receiptLogs, ready };
    }));
    return Object.freeze({ configured: true, ready: checked.length >= 2
      && checked.every((sample) => sample.ready), samples: checked });
  } catch (error) {
    return Object.freeze({ configured: true, ready: false, samples: [], error: error.message });
  }
}

function createRobinhoodRetentionSafetyAudit(options = {}) {
  const database = options.database || db;
  const chainRetentionBlocks = Number(options.chainRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS);
  const holderRetentionBlocks = Number(options.holderRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS);
  const rpcClient = options.rpcClient || (options.archiveRpcUrl ? createEvmJsonRpcClient({
    providers: [{ name: 'robinhood-retention-archive', url: options.archiveRpcUrl }],
    timeoutMs: 60_000, maxRetries: 1,
  }) : null);

  async function inspect() {
    const client = await database.getClient();
    let state;
    let samples = [];
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      state = (await client.query(
        `SELECT capture.next_block AS capture_next_block,
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
                pending.block_number AS oldest_unapplied_holder_block,
                campaign.id AS global_run_id, campaign.status AS global_run_status,
                campaign.next_block AS global_run_next_block,
                mint.block_number AS oldest_pending_deployment_mint_block,
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
           LEFT JOIN LATERAL (SELECT block_number FROM robinhood_holder_transfer_journal
             WHERE chain=$1 AND applied=FALSE ORDER BY block_number LIMIT 1) pending ON TRUE
           LEFT JOIN LATERAL (SELECT id, status, next_block
             FROM robinhood_holder_global_backfill_runs WHERE chain=$1 AND status<>'completed'
             ORDER BY id DESC LIMIT 1) campaign ON TRUE
           LEFT JOIN LATERAL (SELECT MIN(journal.block_number) AS block_number
             FROM robinhood_token_deployment_outbox task JOIN LATERAL (
               SELECT block_number FROM robinhood_holder_transfer_journal
                WHERE chain=$1 AND token_address=task.token_address
                  AND from_wallet='0x0000000000000000000000000000000000000000'
                ORDER BY block_number LIMIT 1
             ) journal ON TRUE WHERE task.chain=$1) mint ON TRUE`,
        [CHAIN, CLASSIFICATION_VERSION]
      )).rows[0] || {};
      const preliminary = evaluate({ state, chainRetentionBlocks, holderRetentionBlocks });
      const cutoff = quantity(preliminary.chain_events.candidate_cutoff_block);
      const start = quantity(state.journal_start_block);
      if (cutoff != null && start != null && cutoff > start) {
        const last = cutoff - 1n;
        const targets = [...new Set([start, start + ((last - start) / 2n), last]
          .map((value) => value.toString()))];
        samples = (await client.query(
          `SELECT block.block_number, block.block_hash,
                  (SELECT COUNT(*) FROM robinhood_chain_events event
                    WHERE event.chain=$1 AND event.block_hash=block.block_hash) AS event_count
             FROM unnest($2::bigint[]) target(block_number)
             JOIN LATERAL (SELECT block_number, block_hash FROM robinhood_chain_blocks
               WHERE chain=$1 AND canonical AND block_number<=target.block_number
               ORDER BY block_number DESC LIMIT 1) block ON TRUE
            ORDER BY block.block_number`, [CHAIN, targets]
        )).rows;
      }
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
    const archive = await (options.archiveProbe || probeArchive)(samples, rpcClient);
    return evaluate({ state, archive, chainRetentionBlocks, holderRetentionBlocks });
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_RETENTION_BLOCKS, createRobinhoodRetentionSafetyAudit, evaluate, probeArchive,
};
