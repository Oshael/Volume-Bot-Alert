'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodBundleFundingLiveQueueRepository } = require(
  '../src/models/robinhood-bundle-funding-live-queue');
const { materializePossibleBundles } = require(
  '../src/services/robinhood-possible-bundle-materializer');
const { CANDIDATES_SQL, PENDING_RISK_SQL, main, parseArgs } = require(
  '../src/utils/repair-robinhood-bundle-funding-archive');

const TOKEN = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;
const row = { token_address: TOKEN, requested_version: '3', anchor_block: '100',
  source_through_block: '200', lookback_blocks: '1000', first_buy_complete: true };
const candidates = [1, 2].map((index) => ({ tokenAddress: TOKEN,
  walletAddress: `0x${String(index).repeat(40)}`, launchBlock: '100',
  firstBuyBlock: String(100 + index), firstBuyTransactionIndex: '0' }));

it('requires explicit confirmation and bounds the Archive work', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.throws(() => parseArgs(['--apply']), /requires --confirm-repair/);
  assert.throws(() => parseArgs(['--limit=501']), /between 1 and 500/);
  assert.throws(() => parseArgs(['--max-blocks=0']), /between 1 and 100000/);
  assert.match(CANDIDATES_SQL, /queue\.status='complete'/);
  assert.match(CANDIDATES_SQL, /queue\.last_error_code='archive_required'/);
  assert.match(CANDIDATES_SQL, /queue\.completed_version=queue\.requested_version/);
  assert.match(CANDIDATES_SQL, /seed\.status='completed'/);
  assert.equal(parseArgs(['--pending-risk']).maxBlocks, 2000);
  assert.throws(() => parseArgs(['--pending-risk', '--max-blocks=5001']), /between 1 and 5000/);
  assert.match(PENDING_RISK_SQL, /queue\.status='pending'/);
  assert.match(PENDING_RISK_SQL, /holder\.ledger_status='live'/);
  assert.match(PENDING_RISK_SQL, /raw\.block_timestamp>NOW\(\)-INTERVAL '72 hours'/);
});

it('previews one historical task without RPC or writes', async () => {
  const sql = [];
  const report = await main([], {
    database: { async query(query) { sql.push(query); return { rows: [row] }; } },
    source: { async loadCandidates() { return candidates; } },
    rpcClientFactory() { throw new Error('RPC must not run in preview'); },
    logger: { log() {} },
  });
  assert.equal(report.mode, 'read-only');
  assert.equal(report.outcomes[0].status, 'ready');
  assert.equal(report.outcomes[0].candidateWallets, 2);
  assert.deepEqual(sql, [CANDIDATES_SQL]);
});

it('applies only ready tasks through the existing materializer and archive queue method', async () => {
  const queue = { repairArchivedEvidence() {} }; let used;
  const report = await main(['--apply',
    '--confirm-repair-robinhood-bundle-funding-archive'], {
    database: { async query() { return { rows: [row] }; } },
    source: { async loadCandidates() { return candidates; } },
    queue, rpcClient: {}, logger: { log() {} },
    async processTask(runtime, task, options) {
      used = { runtime, task, options }; return { status: 'materialized' };
    },
  });
  assert.equal(report.repaired, 1);
  assert.equal(used.runtime.queue.replaceEvidenceAndComplete, queue.repairArchivedEvidence);
  assert.deepEqual(await used.runtime.source.loadCandidates(), candidates);
  assert.equal(used.task.requestedVersion, '3');
  assert.equal(used.options.batchBlocks, 25);
});

it('claims a pending risk and reloads candidates after the claim', async () => {
  const initial = candidates;
  const fresh = [...candidates, { ...candidates[0],
    walletAddress: `0x${'3'.repeat(40)}` }];
  let loads = 0; let claim; let processed;
  const queue = { async claimArchiveRisk(input) { claim = input; return true; },
    completeArchiveRisk() {}, async retry() { throw new Error('unexpected retry'); } };
  const report = await main(['--pending-risk', '--apply',
    '--confirm-repair-robinhood-bundle-funding-archive'], {
    database: { async query(sql) {
      assert.equal(sql, PENDING_RISK_SQL); return { rows: [row] };
    } },
    source: { async loadCandidates() { loads++; return loads === 1 ? initial : fresh; },
      async loadBarrierAddresses() { return []; } },
    queue, rpcClient: {}, logger: { log() {} },
    async processTask(runtime, task) {
      processed = { task, candidates: await runtime.source.loadCandidates(task),
        complete: runtime.queue.replaceEvidenceAndComplete };
      return { status: 'materialized' };
    },
  });
  assert.equal(report.repaired, 1);
  assert.equal(claim.owner, processed.task.owner);
  assert.deepEqual(processed.candidates, fresh);
  assert.equal(processed.complete, queue.completeArchiveRisk);
});

it('does not process a pending task lost to the worker', async () => {
  const report = await main(['--pending-risk', '--apply',
    '--confirm-repair-robinhood-bundle-funding-archive'], {
    database: { async query() { return { rows: [row] }; } },
    source: { async loadCandidates() { return candidates; } },
    queue: { async claimArchiveRisk() { return false; } }, rpcClient: {},
    logger: { log() {} },
    async processTask() { throw new Error('must not process stale task'); },
  });
  assert.equal(report.outcomes[0].status, 'stale');
});

it('fences the pending risk claim by version, readiness and source age', async () => {
  let sql; let parameters;
  const repository = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async query(statement, values) {
      sql = statement; parameters = values; return { rowCount: 1 };
    } },
  });
  assert.equal(await repository.claimArchiveRisk({ tokenAddress: TOKEN,
    requestedVersion: '3', owner: 'archive-test' }), true);
  assert.match(sql, /requested_version = \$3::bigint AND queue\.status = 'pending'/);
  assert.match(sql, /queue\.next_attempt_at <= NOW\(\)/);
  assert.match(sql, /holder\.live_through_block >= queue\.source_through_block/);
  assert.match(sql, /cursor\.source_next_block > queue\.source_through_block/);
  assert.match(sql, /raw\.block_timestamp > NOW\(\) - INTERVAL '72 hours'/);
  assert.deepEqual(parameters, ['robinhood', TOKEN, '3', 'archive-test']);
});

it('fences the completed queue version and commits evidence with the snapshot', async () => {
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.includes('SELECT token_address, rule_version, evidence_version')) {
      return { rowCount: 1, rows: [{ token_address: TOKEN,
        rule_version: 'rh_possible_bundle_v1', evidence_version: 'rh_native_funding_v2',
        requested_version: '3', source_through_block: '200', lookback_blocks: '1000' }] };
    }
    if (sql.includes('SELECT evidence_version, source_kind')) return { rows: [] };
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const repository = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async getClient() { return client; } },
    projectionFence: async () => {},
  });
  const snapshot = materializePossibleBundles({ tokenAddress: TOKEN, candidates,
    evidence: [], evidenceVersion: 'rh_native_funding_v2', sourceKind: 'live',
    sourceVersion: '3', lookbackBlocks: '1000', minimumValueWei: '25000000000000000',
    throughBlockNumber: '200', throughBlockHash: HASH, barrierAddresses: [] });
  const result = await repository.repairArchivedEvidence({ tokenAddress: TOKEN,
    requestedVersion: '3', evidence: [], snapshot });
  assert.equal(result.snapshot.status, 'published');
  assert.match(queries.find((sql) => sql.includes('SELECT token_address, rule_version')),
    /last_error_code = 'archive_required'/);
  assert(queries.some((sql) => sql.includes('DELETE FROM robinhood_bundle_funding_live_evidence')));
  assert(queries.some((sql) => sql.includes('UPDATE robinhood_bundle_funding_live_queue')));
  assert.equal(queries.at(-1), 'COMMIT');
});

it('leaves stale completed rows untouched', async () => {
  const queries = [];
  const repository = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async getClient() { return { async query(sql) {
      queries.push(sql); return { rowCount: 0, rows: [] };
    }, release() {} }; } },
  });
  const result = await repository.repairArchivedEvidence({ tokenAddress: TOKEN,
    requestedVersion: '3', evidence: [], snapshot: {} });
  assert.equal(result, false);
  assert.deepEqual(queries.slice(-1), ['ROLLBACK']);
  assert.equal(queries.some((sql) => sql.includes('DELETE FROM')), false);
});

it('rolls back Archive evidence if the snapshot cannot be published', async () => {
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.includes('SELECT token_address, rule_version, evidence_version')) {
      return { rowCount: 1, rows: [{ token_address: TOKEN,
        rule_version: 'rh_possible_bundle_v1', evidence_version: 'rh_native_funding_v2',
        requested_version: '3', source_through_block: '200', lookback_blocks: '1000' }] };
    }
    if (sql.includes('SELECT evidence_version, source_kind')) {
      return { rows: [{ through_block_number: '201' }] };
    }
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const repository = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async getClient() { return client; } },
    projectionFence: async () => {},
  });
  const snapshot = materializePossibleBundles({ tokenAddress: TOKEN, candidates,
    evidence: [], evidenceVersion: 'rh_native_funding_v2', sourceKind: 'live',
    sourceVersion: '3', lookbackBlocks: '1000', minimumValueWei: '25000000000000000',
    throughBlockNumber: '200', throughBlockHash: HASH, barrierAddresses: [] });
  await assert.rejects(repository.repairArchivedEvidence({ tokenAddress: TOKEN,
    requestedVersion: '3', evidence: [], snapshot }), /was not published/);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some((sql) => sql.includes('UPDATE robinhood_bundle_funding_live_queue')),
    false);
});

it('also rolls back pending Archive evidence when the snapshot is not published', async () => {
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.includes('SELECT token_address, rule_version, evidence_version')) {
      return { rowCount: 1, rows: [{ token_address: TOKEN,
        rule_version: 'rh_possible_bundle_v1', evidence_version: 'rh_native_funding_v2',
        requested_version: '3', source_through_block: '200', lookback_blocks: '1000' }] };
    }
    if (sql.includes('SELECT evidence_version, source_kind')) {
      return { rows: [{ through_block_number: '201' }] };
    }
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const repository = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async getClient() { return client; } }, projectionFence: async () => {},
  });
  const snapshot = materializePossibleBundles({ tokenAddress: TOKEN, candidates,
    evidence: [], evidenceVersion: 'rh_native_funding_v2', sourceKind: 'live',
    sourceVersion: '3', lookbackBlocks: '1000', minimumValueWei: '25000000000000000',
    throughBlockNumber: '200', throughBlockHash: HASH, barrierAddresses: [] });
  await assert.rejects(repository.completeArchiveRisk({ tokenAddress: TOKEN, owner: 'archive',
    requestedVersion: '3', evidence: [], snapshot }), /was not published/);
  assert.equal(queries.at(-1), 'ROLLBACK');
});
