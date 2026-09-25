require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodArchiveDeploymentDiscovery,
} = require('../services/robinhood-archive-deployment-discovery');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../models/robinhood-token-deployment-outbox');
const {
  createRobinhoodHolderDeploymentVerifier,
} = require('../services/robinhood-holder-deployment-verifier');
const {
  createLocalCodeTransitionResolver,
} = require('../services/robinhood-token-deployment-worker');

const CONFIRM_FLAG = '--confirm-recover-robinhood-holder-deployments';

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(raw).toString();
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    if (argument === CONFIRM_FLAG) {
      if (values.confirm) throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
      values.confirm = true;
      continue;
    }
    if (argument === '--catalog-only') {
      if (values.catalogOnly) throw new Error('--catalog-only cannot be repeated');
      values.catalogOnly = true;
      continue;
    }
    if (argument === '--pinned-live-rpc-error') {
      if (values.pinnedLiveRpcError) throw new Error('repeated --pinned-live-rpc-error');
      values.pinnedLiveRpcError = true;
      continue;
    }
    const match = argument.match(/^--(limit|concurrency|timeout-ms)=(.+)$/);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    if (values[match[1]] !== undefined) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  return Object.freeze({
    confirm: values.confirm === true,
    catalogOnly: values.catalogOnly === true,
    pinnedLiveRpcError: values.pinnedLiveRpcError === true,
    limit: bounded(values.limit, 100, 1, 1000, '--limit'),
    concurrency: bounded(values.concurrency, 2, 1, 8, '--concurrency'),
    timeoutMs: bounded(values['timeout-ms'], 30_000, 1000, 60_000, '--timeout-ms'),
  });
}

async function listCandidates(database, limit, input = {}) {
  const pinnedOnly = input.pinnedLiveRpcError === true;
  const catalogJoin = input.catalogOnly === true
    ? `INNER JOIN token_catalog catalog
           ON catalog.chain = outbox.chain AND catalog.address = outbox.token_address`
    : '';
  const pinnedFilter = pinnedOnly ? `AND outbox.status = 'archive_required'
          AND outbox.mint_block_number IS NOT NULL
          AND outbox.last_error LIKE
            'rpc_code_transition:rpc_error:eth_getCode RPC error -32000%'` : '';
  const { rows } = await database.query(
    `WITH queued AS MATERIALIZED (
       SELECT outbox.token_address, outbox.created_at, outbox.attempt_count,
              outbox.mint_block_number, outbox.mint_block_hash,
              outbox.mint_transaction_hash,
              attribution.attribution_block,
              attribution.source AS attribution_source,
              attribution.attribution_block IS NOT NULL AS exact
         FROM robinhood_token_deployment_outbox outbox
         ${catalogJoin}
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = outbox.chain
          AND attribution.token_address = outbox.token_address
          AND attribution.attribution_block IS NOT NULL
          AND attribution.source = ANY(ARRAY[
            'blockscout_internal', 'rpc_code_transition', 'rpc_direct',
            'rpc_trace', 'launchpad_event'
          ]::varchar[])
        WHERE outbox.chain = 'robinhood'
          AND (attribution.attribution_block IS NULL OR outbox.status = 'archive_required')
          ${pinnedFilter}
        ORDER BY
          CASE WHEN attribution.attribution_block IS NOT NULL THEN 0
               WHEN outbox.created_at >= NOW() - INTERVAL '10 minutes' THEN 1 ELSE 2 END,
          outbox.created_at DESC, outbox.token_address
        LIMIT $1::int
     )
     SELECT queued.token_address, queued.created_at, queued.attempt_count,
            queued.attribution_block, queued.attribution_source, queued.exact,
            ${pinnedOnly ? 'queued.mint_block_number' : 'mint.block_number'} AS upper_block,
            queued.mint_block_hash, queued.mint_transaction_hash
       FROM queued
       LEFT JOIN LATERAL (
         SELECT mint.block_number
           FROM (
             SELECT journal.block_number, journal.transaction_index, journal.log_index
               FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = 'robinhood'
                AND journal.token_address = queued.token_address
                AND journal.applied = FALSE
                AND journal.from_wallet = '0x0000000000000000000000000000000000000000'
             UNION ALL
             SELECT journal.block_number, journal.transaction_index, journal.log_index
               FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = 'robinhood'
                AND journal.token_address = queued.token_address
                AND journal.applied = TRUE
                AND journal.from_wallet = '0x0000000000000000000000000000000000000000'
           ) mint
          ORDER BY mint.block_number, mint.transaction_index, mint.log_index
          LIMIT 1
       ) mint ON queued.exact = FALSE ${pinnedOnly ? 'AND FALSE' : ''}
      ORDER BY queued.created_at DESC, queued.token_address`,
    [limit]
  );
  return Object.freeze(rows.map((row) => Object.freeze({
    tokenAddress: row.token_address,
    upperBlock: row.upper_block == null ? null : String(row.upper_block),
    exact: row.exact === true,
    attributionBlock: row.attribution_block == null ? null : String(row.attribution_block),
    attributionSource: row.attribution_source || null,
    createdAt: row.created_at,
    attemptCount: Number(row.attempt_count) || 0,
    pinnedHint: pinnedOnly ? Object.freeze({
      tokenAddress: row.token_address, blockNumber: String(row.upper_block),
      blockHash: row.mint_block_hash, transactionHash: row.mint_transaction_hash,
    }) : null,
  })));
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0;
  const results = new Array(items.length);
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function buildRuntime(options, deps = {}) {
  const env = deps.env || process.env;
  const rpcUrl = String(env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  const database = deps.database || db;
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-holder-deployment-archive', url: rpcUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  let archiveHeadPromise = null;
  const getArchiveHead = () => {
    archiveHeadPromise ||= Promise.resolve(rpcClient.request('eth_blockNumber'))
      .then((value) => quantity(value, 'archive head'))
      .catch((error) => { archiveHeadPromise = null; throw error; });
    return archiveHeadPromise;
  };
  return Object.freeze({
    outbox: (deps.outboxFactory || createRobinhoodTokenDeploymentOutboxRepository)({ database }),
    attributions: (deps.attributionFactory || createRobinhoodTokenAttributionRepository)({
      database,
    }),
    discovery: (deps.discoveryFactory || createRobinhoodArchiveDeploymentDiscovery)({
      rpcClient,
      blockCreationLookup: async () => null,
    }),
    verifier: (deps.verifierFactory || createRobinhoodHolderDeploymentVerifier)({
      rpcClient,
      internalCreationLookup: async () => null,
    }),
    localResolver: (deps.localResolverFactory || createLocalCodeTransitionResolver)(rpcClient),
    getArchiveHead,
  });
}

async function recoverCandidate(runtime, candidate) {
  async function complete() {
    if (candidate.pinnedHint) {
      const cleared = await runtime.outbox.completePinnedRecovered(candidate.pinnedHint);
      if (!cleared) throw new Error('pinned deployment task changed during recovery');
    } else {
      await runtime.outbox?.completeRecovered?.(candidate.tokenAddress);
    }
  }
  if (candidate.exact) {
    await complete();
    return Object.freeze({
      status: 'unchanged', tokenAddress: candidate.tokenAddress,
      source: candidate.attributionSource, deploymentBlock: candidate.attributionBlock,
    });
  }
  if (candidate.pinnedHint) {
    const inspected = await runtime.localResolver.inspect(candidate.pinnedHint);
    if (inspected?.status === 'transition') {
      const result = await runtime.attributions.recordCodeTransitions([inspected.transition]);
      if (result.attributed !== 1) {
        throw new Error('pinned mint attribution was not persisted');
      }
      await complete();
      return Object.freeze({
        status: 'recovered', tokenAddress: candidate.tokenAddress,
        source: 'rpc_code_transition', deploymentBlock: inspected.transition.blockNumber,
      });
    }
    if (inspected?.status !== 'preexisting-code') {
      throw new Error('pinned mint archive inspection is inconclusive');
    }
  }
  const upperBlock = candidate.upperBlock ?? await runtime.getArchiveHead();
  const discovered = await runtime.discovery.discover({
    ...candidate,
    upperBlock,
    exactBlockHint: candidate.upperBlock != null,
    blockEvidenceOnly: true,
  });
  if (discovered.source === 'rpc_code_transition') {
    const result = await runtime.attributions.recordCodeTransitions([discovered]);
    if (candidate.pinnedHint && result.attributed !== 1) {
      throw new Error('historical attribution was not persisted');
    }
    await complete();
    return Object.freeze({
      status: result.attributed === 1 ? 'recovered' : 'unchanged',
      tokenAddress: candidate.tokenAddress,
      source: discovered.source,
      deploymentBlock: discovered.blockNumber,
    });
  }
  const deployment = discovered.source === 'launchpad_event'
    ? discovered : await runtime.verifier.verifyDirectDeployment(discovered);
  await runtime.attributions.recordVerifiedDirectDeployments([deployment]);
  await complete();
  return Object.freeze({
    status: 'recovered', tokenAddress: candidate.tokenAddress,
    source: deployment.source, deploymentBlock: deployment.blockNumber,
  });
}

function failure(candidate, error) {
  return Object.freeze({
    status: 'failed', tokenAddress: candidate.tokenAddress,
    error: `${error?.code || 'archive_recovery_failed'}:${error?.message || error}`.slice(0, 500),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const candidates = await (deps.listCandidates || listCandidates)(
    database, options.limit, {
      catalogOnly: options.catalogOnly,
      pinnedLiveRpcError: options.pinnedLiveRpcError,
    }
  );
  if (!options.confirm) {
    const report = {
      mode: 'read-only', candidates: candidates.length,
      headFallbackCandidates: candidates.filter(({ exact, upperBlock }) => (
        !exact && upperBlock == null
      )).length,
      selection: candidates,
    };
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const runtime = deps.runtime || buildRuntime(options, deps);
  const outcomes = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    try { return await recoverCandidate(runtime, candidate); }
    catch (error) { return failure(candidate, error); }
  });
  const report = {
    mode: 'apply', candidates: candidates.length,
    headFallbackCandidates: candidates.filter(({ exact, upperBlock }) => (
      !exact && upperBlock == null
    )).length,
    recovered: outcomes.filter(({ status }) => status === 'recovered').length,
    unchanged: outcomes.filter(({ status }) => status === 'unchanged').length,
    failed: outcomes.filter(({ status }) => status === 'failed').length,
    bySource: Object.fromEntries(['rpc_code_transition', 'rpc_direct', 'rpc_trace',
      'launchpad_event', 'blockscout_internal'].map((source) => [
      source, outcomes.filter((outcome) => outcome.source === source).length,
    ]).filter(([, count]) => count > 0)),
    failures: outcomes.filter(({ status }) => status === 'failed'),
  };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood holder deployment recovery failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, listCandidates, main, parseArgs, recoverCandidate,
  __private: { buildRuntime, mapConcurrent },
};
