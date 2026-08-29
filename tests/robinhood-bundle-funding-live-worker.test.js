const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  processTask, __private: { buildRuntime },
} = require('../src/services/robinhood-bundle-funding-live-worker');

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLETS = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`];

it('scans a token with one VPS Archive provider and atomically replaces evidence', async () => {
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
    lookbackBlocks: '1000', owner: 'test',
  }, { batchBlocks: 50 }, {
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

it('requires exactly one VPS Archive endpoint', () => {
  assert.throws(() => buildRuntime({ env: {} }, {}), /RH_NODE_RPC_URL Archive/);
  let providers;
  buildRuntime({ env: { RH_NODE_RPC_URL: 'http://127.0.0.1:8545' },
    rpcClientFactory(options) { providers = options.providers; return {}; },
    queueFactory: () => ({}), sourceFactory: () => ({}), database: {},
  }, { timeoutMs: 60_000 });
  assert.deepEqual(providers, [{ name: 'robinhood-vps-archive',
    url: 'http://127.0.0.1:8545' }]);
});
