'use strict';

require('dotenv').config();
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

function integer(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {}; let apply = false; let confirmed = false;
  for (const argument of argv) {
    if (argument === '--apply' && !apply) apply = true;
    else if (argument === CONFIRM_FLAG && !confirmed) confirmed = true;
    else {
      const match = /^--(limit|batch-blocks|max-blocks|after-token)=(.+)$/.exec(argument);
      if (!match || values[match[1]] != null) throw new Error(`unknown argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  if (apply !== confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  const afterToken = String(values['after-token'] || '');
  if (afterToken && !ADDRESS.test(afterToken)) throw new Error('--after-token is invalid');
  return Object.freeze({ apply, afterToken,
    limit: integer(values.limit, 1, 1, 500, '--limit'),
    batchBlocks: integer(values['batch-blocks'], 25, 1, 100, '--batch-blocks'),
    maxBlocks: integer(values['max-blocks'], 5_000, 1, 100_000, '--max-blocks') });
}

async function select(database, source, options) {
  const { rows } = await database.query(CANDIDATES_SQL, [options.afterToken, options.limit]);
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
    const reason = plan.candidateWallets < 2 ? 'candidate_proof_missing'
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
  const outcomes = [];
  for (const item of selected) {
    if (item.status !== 'ready') {
      outcomes.push({ tokenAddress: item.task.tokenAddress, status: 'deferred',
        reason: item.reason });
      continue;
    }
    try {
      const runtime = { database, source: { ...source,
        loadCandidates: async () => item.candidates }, sourceMode: RPC_SOURCE, rpcClient,
      queue: { replaceEvidenceAndComplete: queue.repairArchivedEvidence } };
      const result = await (deps.processTask || processTask)(runtime, item.task,
        { batchBlocks: options.batchBlocks });
      outcomes.push({ tokenAddress: item.task.tokenAddress,
        status: result.status, plannedBlocks: item.blocksToScan });
    } catch (error) {
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
  const report = { mode: options.apply ? 'apply' : 'read-only', candidates: selected.length,
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

module.exports = { CANDIDATES_SQL, CONFIRM_FLAG, archiveClient, main, parseArgs, select };
