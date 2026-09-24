'use strict';

require('dotenv').config();
const { randomUUID } = require('crypto');
const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createRobinhoodBundleFundingLiveQueueRepository } = require(
  '../models/robinhood-bundle-funding-live-queue');
const { createRobinhoodBundleFundingLiveSource } = require(
  '../models/robinhood-bundle-funding-live-source');
const { planBundleFundingScan } = require('../services/robinhood-bundle-funding-scan-plan');
const { processTask, RPC_SOURCE } = require('../services/robinhood-bundle-funding-live-worker');

const CONFIRM_FLAG = '--confirm-repair-robinhood-bundle-funding-archive';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const FLAGS = new Set(['--apply', CONFIRM_FLAG, '--pending-risk', '--retry-failed-now']);
const CANDIDATES_SQL = `SELECT queue.token_address, queue.requested_version::text,
       queue.anchor_block::text, queue.source_through_block::text,
       queue.lookback_blocks::text,
       EXISTS (SELECT 1 FROM robinhood_first_buy_live_cursors cursor
         JOIN robinhood_first_buy_backfill_runs seed
           ON seed.chain=cursor.chain AND seed.id=cursor.seed_run_id
        WHERE cursor.chain=queue.chain AND seed.status='completed'
          AND cursor.source_next_block>queue.source_through_block) AS first_buy_complete
  FROM robinhood_bundle_funding_live_queue queue
 WHERE queue.chain='robinhood' AND queue.status='complete'
   AND queue.last_error_code='archive_required'
   AND queue.completed_version=queue.requested_version
   AND queue.token_address>$1
 ORDER BY queue.token_address LIMIT $2::int`;
const PENDING_RISK_SQL = `SELECT queue.token_address, queue.requested_version::text,
       queue.anchor_block::text, queue.source_through_block::text,
       queue.lookback_blocks::text, TRUE AS first_buy_complete
  FROM robinhood_bundle_funding_live_queue queue
  JOIN robinhood_holder_token_states holder
    ON holder.chain=queue.chain AND holder.token_address=queue.token_address
 WHERE queue.chain='robinhood' AND queue.status='pending'
   AND ((NOT $3::boolean AND queue.next_attempt_at<=NOW())
     OR ($3::boolean AND queue.last_error_code='funding_live_failed'))
   AND queue.token_address>$1
   AND holder.ledger_status='live'
   AND holder.live_through_block>=queue.source_through_block
   AND EXISTS (SELECT 1 FROM robinhood_first_buy_live_cursors cursor
     JOIN robinhood_first_buy_backfill_runs seed
       ON seed.chain=cursor.chain AND seed.id=cursor.seed_run_id
    WHERE cursor.chain=queue.chain AND seed.status='completed'
      AND cursor.source_next_block>queue.source_through_block)
   AND NOT EXISTS (SELECT 1 FROM robinhood_chain_blocks raw
     WHERE raw.chain=queue.chain AND raw.canonical
       AND raw.block_number=GREATEST(queue.anchor_block-queue.lookback_blocks, 0)
       AND raw.block_timestamp>NOW()-INTERVAL '72 hours')
 ORDER BY queue.token_address LIMIT $2::int`;

function integer(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function splitArgs(argv) {
  const values = {}; const flags = new Set();
  for (const argument of argv) {
    if (FLAGS.has(argument)) {
      if (flags.has(argument)) throw new Error(`repeated argument: ${argument}`);
      flags.add(argument); continue;
    }
    const match = /^--(limit|batch-blocks|max-blocks|after-token)=(.+)$/.exec(argument);
    if (!match || values[match[1]] != null) throw new Error(`unknown argument: ${argument}`);
    values[match[1]] = match[2];
  }
  return { values, flags };
}

function parseArgs(argv = []) {
  const { values, flags } = splitArgs(argv);
  const apply = flags.has('--apply');
  const confirmed = flags.has(CONFIRM_FLAG);
  const pendingRisk = flags.has('--pending-risk');
  const retryFailedNow = flags.has('--retry-failed-now');
  if (apply !== confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  if (retryFailedNow && !pendingRisk) {
    throw new Error('--retry-failed-now requires --pending-risk');
  }
  const afterToken = String(values['after-token'] || '');
  if (afterToken && !ADDRESS.test(afterToken)) throw new Error('--after-token is invalid');
  const maxBlocks = integer(values['max-blocks'], pendingRisk ? 2_000 : 5_000,
    1, pendingRisk ? 5_000 : 100_000, '--max-blocks');
  return Object.freeze({ apply, pendingRisk, retryFailedNow, afterToken,
    limit: integer(values.limit, 1, 1, 500, '--limit'),
    batchBlocks: integer(values['batch-blocks'], 25, 1, 100, '--batch-blocks'),
    maxBlocks });
}

async function select(database, source, options) {
  const { rows } = await database.query(options.pendingRisk ? PENDING_RISK_SQL : CANDIDATES_SQL,
    options.pendingRisk ? [options.afterToken, options.limit, options.retryFailedNow]
      : [options.afterToken, options.limit]);
  const selected = [];
  for (const row of rows) {
    const task = { tokenAddress: row.token_address, requestedVersion: row.requested_version,
      anchorBlock: row.anchor_block, sourceThroughBlock: row.source_through_block,
      lookbackBlocks: row.lookback_blocks };
    if (!row.first_buy_complete) {
      selected.push({ task, status: 'deferred', reason: 'first_buy_coverage_missing' });
      continue;
    }
    const candidates = await source.loadCandidates(task);
    const plan = planBundleFundingScan({ sourceFromBlock: '0',
      sourceThroughBlock: task.sourceThroughBlock, lookbackBlocks: task.lookbackBlocks,
      candidates });
    const blocksToScan = Number(plan.blocksToScan);
    const reason = !options.pendingRisk && plan.candidateWallets < 2 ? 'candidate_proof_missing'
      : blocksToScan > options.maxBlocks ? 'scan_exceeds_max_blocks' : null;
    selected.push({ task, status: reason ? 'deferred' : 'ready', reason,
      candidateWallets: plan.candidateWallets, blocksToScan,
      candidates: reason ? null : candidates });
  }
  return selected;
}

function archiveClient(env, factory = createEvmJsonRpcClient) {
  const url = String(env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!url) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required for apply');
  return factory({ providers: [{ name: 'robinhood-funding-archive', url }],
    timeoutMs: 60_000, maxRetries: 1 });
}

function preview(selected) {
  return selected.map((item) => ({ tokenAddress: item.task.tokenAddress,
      status: item.status, reason: item.reason, candidateWallets: item.candidateWallets,
      blocksToScan: item.blocksToScan }));
}

async function applySelected(selected, options, deps, database, source) {
  const rpcClient = deps.rpcClient || archiveClient(deps.env || process.env,
    deps.rpcClientFactory);
  const queue = deps.queue || createRobinhoodBundleFundingLiveQueueRepository({ database });
  const owner = `funding-archive-${process.pid}-${randomUUID()}`;
  const outcomes = [];
  for (const item of selected) {
    if (item.status !== 'ready') {
      outcomes.push({ tokenAddress: item.task.tokenAddress, status: 'deferred',
        reason: item.reason });
      continue;
    }
    let claimed = false;
    try {
      if (options.pendingRisk) {
        claimed = await queue.claimArchiveRisk({ ...item.task, owner,
          retryFailedNow: options.retryFailedNow });
        if (!claimed) {
          outcomes.push({ tokenAddress: item.task.tokenAddress, status: 'stale' });
          continue;
        }
      }
      const runtimeSource = { ...source, loadCandidates: async () => {
        if (!options.pendingRisk) return item.candidates;
        const current = await source.loadCandidates(item.task);
        const plan = planBundleFundingScan({ sourceFromBlock: '0',
          sourceThroughBlock: item.task.sourceThroughBlock,
          lookbackBlocks: item.task.lookbackBlocks, candidates: current });
        if (BigInt(plan.blocksToScan) > BigInt(options.maxBlocks)) {
          throw new Error('funding Archive scan exceeds max blocks after claim');
        }
        return current;
      } };
      const runtime = { database, source: runtimeSource, sourceMode: RPC_SOURCE, rpcClient,
      queue: options.pendingRisk ? { replaceEvidenceAndComplete: queue.completeArchiveRisk }
        : { replaceEvidenceAndComplete: queue.repairArchivedEvidence } };
      const result = await (deps.processTask || processTask)(runtime,
        { ...item.task, ...(options.pendingRisk ? { owner } : {}) },
        { batchBlocks: options.batchBlocks });
      outcomes.push({ tokenAddress: item.task.tokenAddress,
        status: result.status, plannedBlocks: item.blocksToScan });
    } catch (error) {
      if (claimed) await queue.retry({ ...item.task, owner, retryMs: 60_000,
        error }).catch(() => {});
      outcomes.push({ tokenAddress: item.task.tokenAddress, status: 'unresolved',
        error: String(error.message || error).slice(0, 500) });
    }
  }
  return outcomes;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const source = deps.source || createRobinhoodBundleFundingLiveSource({ database });
  const selected = await select(database, source, options);
  const outcomes = options.apply
    ? await applySelected(selected, options, deps, database, source) : preview(selected);
  const report = { mode: options.apply ? 'apply' : 'read-only',
    scope: options.pendingRisk ? 'pending_risk' : 'complete_archive',
    candidates: selected.length,
    repaired: outcomes.filter((item) => item.status === 'materialized').length,
    unresolved: outcomes.filter((item) => item.status === 'unresolved').length,
    nextCursor: selected.at(-1)?.task.tokenAddress || null, outcomes };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood bundle funding Archive repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CANDIDATES_SQL, PENDING_RISK_SQL, CONFIRM_FLAG,
  archiveClient, main, parseArgs, select };
