const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  CANONICAL_SOURCE, RPC_SOURCE, processTask,
  __private: { buildRuntime, normalizeOptions },
} = require('../src/services/robinhood-bundle-funding-live-worker');
const {
  createRobinhoodBundleFundingLiveQueueRepository,
} = require('../src/models/robinhood-bundle-funding-live-queue');

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLETS = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`];

it('scans a token with the standard live provider and atomically replaces evidence', async () => {
  let persisted; let classificationInput;
  const candidates = WALLETS.map((walletAddress, index) => ({
    tokenAddress: TOKEN, walletAddress, launchBlock: '100',
    firstBuyBlock: String(101 + index), firstBuyTransactionIndex: '0',
  }));
  const evidence = { candidateWallet: WALLETS[0], transactionHash: `0x${'b'.repeat(64)}`,
    hop: 1 };
  const runtime = { rpcClient: {}, source: { async loadCandidates() { return candidates; },
    async loadBarrierAddresses() { return []; } },
    queue: { async replaceEvidenceAndComplete(value) { persisted = value; return true; } } };
  const result = await processTask(runtime, {
    tokenAddress: TOKEN, requestedVersion: '2', sourceThroughBlock: '200',
    anchorBlock: '100', lookbackBlocks: '1000', owner: 'test',
  }, { batchBlocks: 50, sourceMode: RPC_SOURCE }, {
    readerFactory() { return { async assertChain() { return '4663'; },
      async checkpoint() { return `0x${'c'.repeat(64)}`; } }; },
    async materialize() { return { causalEvidence: [evidence] }; },
    classify(input) {
      classificationInput = input; return { state: {}, groups: [], members: [] };
    },
  });
  assert.deepEqual(result, { status: 'materialized', tokenAddress: TOKEN,
    candidates: 2, evidence: 1, groups: 0, members: 0 });
  assert.deepEqual(persisted.evidence, [evidence]);
  assert.deepEqual(persisted.snapshot, { state: {}, groups: [], members: [] });
  assert.deepEqual({ sourceKind: classificationInput.sourceKind,
    sourceVersion: classificationInput.sourceVersion,
    minimumValueWei: classificationInput.minimumValueWei }, {
    sourceKind: 'live', sourceVersion: '2', minimumValueWei: '25000000000000000',
  });
});

it('reuses the standard Robinhood live RPC configuration without an Archive env', () => {
  let receivedOptions;
  const options = normalizeOptions({ timeoutMs: 60_000, rpcOptions: {
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com', rpcMaxRetries: 3,
  } });
  buildRuntime({
    rpcClientFactory(options) { receivedOptions = options; return {}; },
    queueFactory: () => ({}), sourceFactory: () => ({}), database: {},
  }, options);
  assert.deepEqual(receivedOptions, {
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    rpcMaxRetries: 3,
    rpcTimeoutMs: 60_000,
  });
});

it('selects the canonical reader without constructing an RPC client', async () => {
  let readerInput; let coverage; let persisted;
  const candidates = WALLETS.map((walletAddress, index) => ({
    tokenAddress: TOKEN, walletAddress, launchBlock: '100',
    firstBuyBlock: String(101 + index), firstBuyTransactionIndex: '0',
  }));
  const options = normalizeOptions({ sourceMode: CANONICAL_SOURCE });
  const runtime = buildRuntime({
    database: {}, queueFactory: () => ({
      async replaceEvidenceAndComplete(value) { persisted = value; return true; },
    }), sourceFactory: () => ({
      async loadCandidates() { return candidates; }, async loadBarrierAddresses() { return []; },
    }), rpcClientFactory() { throw new Error('RPC must not be constructed'); },
  }, options);
  await processTask(runtime, {
    tokenAddress: TOKEN, requestedVersion: '3', sourceThroughBlock: '200',
    anchorBlock: '100', lookbackBlocks: '1000', owner: 'canonical-test',
  }, options, {
    canonicalReaderFactory(input) { readerInput = input; return {
      async assertChain() { return '4663'; }, async checkpoint() { return `0x${'c'.repeat(64)}`; },
      async assertCoverage(value) { coverage = value; },
    }; },
    async materialize() { return { causalEvidence: [] }; },
    classify() { return { state: {}, groups: [], members: [] }; },
  });
  assert.equal(runtime.sourceMode, CANONICAL_SOURCE);
  assert.deepEqual(coverage, { fromBlock: '0', throughBlock: '103' });
  assert.deepEqual(readerInput.candidateWallets, WALLETS);
  assert.equal(persisted.requestedVersion, '3');
});

it('defaults to RPC and rejects unknown live sources', () => {
  assert.equal(normalizeOptions({}, {}).sourceMode, RPC_SOURCE);
  assert.throws(() => normalizeOptions({ sourceMode: 'archive' }, {}),
    /must be rpc or canonical_journal/);
});

it('preserves historical evidence when the canonical coverage gate fails', async () => {
  let replaced = false;
  const runtime = {
    sourceMode: CANONICAL_SOURCE, database: {},
    source: { async loadCandidates() { return []; } },
    queue: { async replaceEvidenceAndComplete() { replaced = true; } },
  };
  await assert.rejects(processTask(runtime, {
    tokenAddress: TOKEN, requestedVersion: '4', anchorBlock: '100',
    sourceThroughBlock: '200', lookbackBlocks: '1000', owner: 'historical-test',
  }, normalizeOptions({ sourceMode: CANONICAL_SOURCE }, {}), {
    canonicalReaderFactory() { return {
      async assertChain() { return '4663'; },
      async assertCoverage() {
        throw Object.assign(new Error('historical gap'), {
          code: 'canonical_bundle_funding_source_gap', fatal: true,
        });
      },
    }; },
  }), (error) => error.code === 'canonical_bundle_funding_source_gap');
  assert.equal(replaced, false);
});

it('marks pre-journal work for Archive repair without retrying or replacing evidence', async () => {
  let preserved; let retried = false; let replaced = false;
  const task = { tokenAddress: TOKEN, requestedVersion: '5', anchorBlock: '100',
    sourceThroughBlock: '200', lookbackBlocks: '1000', attemptCount: 1 };
  const runtime = {
    sourceMode: CANONICAL_SOURCE, database: {},
    source: { async loadCandidates() { return []; } },
    queue: {
      async claim() { return task; },
      async preserveEvidenceAndComplete(value) { preserved = value; return true; },
      async retry() { retried = true; },
      async replaceEvidenceAndComplete() { replaced = true; },
    },
  };
  const scheduled = [];
  const worker = require('../src/services/robinhood-bundle-funding-live-worker')
    .createRobinhoodBundleFundingLiveWorker({
      runtime, schedule(callback) { scheduled.push(callback); return { unref() {} }; },
      listenerFactory: () => ({ async start() {}, async stop() {} }),
      canonicalReaderFactory() { return {
        async assertChain() { return '4663'; },
        async assertCoverage() {
          throw Object.assign(new Error('range starts before journal'), {
            code: 'canonical_bundle_funding_source_gap', reason: 'before_journal',
            journalStartBlock: '500',
          });
        },
      }; },
    });
  worker.start({ enabled: true, sourceMode: CANONICAL_SOURCE });
  assert.equal((await worker.runOnce()).status, 'archive-required');
  assert.equal(preserved.tokenAddress, TOKEN);
  assert.equal(retried, false);
  assert.equal(replaced, false);
  assert.equal(worker.getStatus().totalArchiveRequired, 1);
  assert.equal(worker.getStatus().lastError, null);
  await worker.stop();
});

it('completes Archive-required work without deleting its persisted evidence', async () => {
  let statement;
  const queue = createRobinhoodBundleFundingLiveQueueRepository({
    database: { async query(sql, params) {
      statement = { sql, params }; return { rowCount: 1 };
    } },
  });
  assert.equal(await queue.preserveEvidenceAndComplete({
    tokenAddress: TOKEN, owner: 'owner', requestedVersion: '7', message: 'before journal',
  }), true);
  assert.match(statement.sql, /status = 'complete'/);
  assert.match(statement.sql, /completed_version = requested_version/);
  assert.match(statement.sql, /last_error_code = 'archive_required'/);
  assert.doesNotMatch(statement.sql, /DELETE FROM robinhood_bundle_funding_live_evidence/);
  assert.deepEqual(statement.params, ['robinhood', TOKEN, 'owner', '7', 'before journal']);
});
