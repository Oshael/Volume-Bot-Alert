require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodCanonicalDirectCreatorSource,
} = require('../models/robinhood-canonical-direct-creator-source');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodHolderDeploymentVerifier,
} = require('../services/robinhood-holder-deployment-verifier');

const CONFIRM_FLAG = '--confirm-repair-robinhood-bundle-redistribution-creators';

function bounded(value, fallback, minimum, maximum, label) {
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
      const match = /^--(limit|concurrency|timeout-ms)=(.+)$/.exec(argument);
      if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  if (apply !== confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  return Object.freeze({
    apply, limit: bounded(values.limit, 100, 1, 1000, '--limit'),
    concurrency: bounded(values.concurrency, 2, 1, 8, '--concurrency'),
    timeoutMs: bounded(values['timeout-ms'], 60_000, 1000, 300_000, '--timeout-ms'),
  });
}

async function listCandidates(database, limit) {
  const { rows } = await database.query(`SELECT queue.token_address,
      attribution.attribution_block::text
    FROM robinhood_bundle_redistribution_queue queue
    INNER JOIN robinhood_token_attributions attribution
      ON attribution.chain=queue.chain AND attribution.token_address=queue.token_address
   WHERE queue.chain='robinhood' AND queue.status='pending'
     AND queue.last_error_code='redistribution_source_not_ready'
     AND queue.last_error_message LIKE '%creator_unavailable%'
     AND attribution.creator_address IS NULL
     AND attribution.source='rpc_code_transition'
     AND attribution.attribution_block IS NOT NULL
   ORDER BY queue.updated_at, queue.token_address LIMIT $1::int`, [limit]);
  return Object.freeze(rows.map((row) => Object.freeze({
    tokenAddress: row.token_address, blockNumber: String(row.attribution_block),
  })));
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0; const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1; results[index] = await operation(items[index]);
    }
  }));
  return results;
}

function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const rpcUrl = String((deps.env || process.env).ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-redistribution-creator-archive', url: rpcUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  return Object.freeze({
    source: (deps.sourceFactory || createRobinhoodCanonicalDirectCreatorSource)({ database }),
    verifier: (deps.verifierFactory || createRobinhoodHolderDeploymentVerifier)({ rpcClient }),
    attributions: (deps.attributionFactory || createRobinhoodTokenAttributionRepository)({ database }),
  });
}

async function repairCandidate(runtime, candidate) {
  const blocks = await runtime.source.readRange(candidate.blockNumber, candidate.blockNumber);
  const deployment = blocks.get(candidate.blockNumber)?.deployments.find(
    (item) => item.tokenAddress === candidate.tokenAddress
  ) || await runtime.verifier.verifyBlockTraceDeployment(candidate);
  await runtime.attributions.recordVerifiedDirectDeployments([deployment]);
  return Object.freeze({ tokenAddress: candidate.tokenAddress, status: 'repaired',
    source: deployment.source, transactionHash: deployment.transactionHash });
}

async function requeue(database, tokens) {
  if (!tokens.length) return 0;
  const result = await database.query(`UPDATE robinhood_bundle_redistribution_queue SET
      next_attempt_at=NOW(), last_error_code=NULL, last_error_message=NULL, updated_at=NOW()
    WHERE chain='robinhood' AND status='pending' AND token_address=ANY($1::varchar[])`, [tokens]);
  return result.rowCount;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv); const database = deps.database || db;
  const candidates = await (deps.listCandidates || listCandidates)(database, options.limit);
  if (!options.apply) {
    const report = { mode: 'read-only', candidates: candidates.length, selection: candidates };
    (deps.logger || console).log(JSON.stringify(report, null, 2)); return report;
  }
  const runtime = deps.runtime || buildRuntime(options, deps);
  const outcomes = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    try { return await repairCandidate(runtime, candidate); }
    catch (error) { return { tokenAddress: candidate.tokenAddress, status: 'unresolved',
      error: `${error?.code || 'creator_repair_failed'}:${error?.message || error}`.slice(0, 500) }; }
  });
  const repaired = outcomes.filter(({ status }) => status === 'repaired');
  const requeued = await (deps.requeue || requeue)(database, repaired.map(({ tokenAddress }) => tokenAddress));
  const report = { mode: 'apply', candidates: candidates.length, repaired: repaired.length,
    requeued, unresolved: outcomes.filter(({ status }) => status === 'unresolved').length,
    bySource: Object.fromEntries(['rpc_direct', 'rpc_trace', 'launchpad_event'].map((source) => [
      source, repaired.filter((item) => item.source === source).length,
    ]).filter(([, count]) => count)), outcomes };
  (deps.logger || console).log(JSON.stringify(report, null, 2)); return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood redistribution creator repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, listCandidates, main, parseArgs, repairCandidate,
  __private: { buildRuntime, mapConcurrent, requeue } };
