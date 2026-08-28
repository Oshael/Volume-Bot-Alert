const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBundleFundingReader, preflightBundleFunding,
  __private: { sampleBatches },
} = require('../src/services/robinhood-bundle-funding-reader');
const {
  archiveClient, main, parseArgs,
} = require('../src/utils/preflight-robinhood-bundle-funding');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const TX_HASH = `0x${'c'.repeat(64)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const FUNDER = `0x${'2'.repeat(40)}`;
const TOKEN = `0x${'3'.repeat(40)}`;

function fullBlock(number) {
  return {
    number: `0x${BigInt(number).toString(16)}`, hash: HASH_A, timestamp: '0x64',
    transactions: [
      { hash: TX_HASH, transactionIndex: '0x0', from: FUNDER, to: WALLET, value: '0xa' },
      { hash: HASH_B, transactionIndex: '0x1', from: WALLET, to: FUNDER, value: '0x0' },
    ],
  };
}

describe('Robinhood bundle funding archive reader', () => {
  it('captures exact top-level native evidence and candidate direction', async () => {
    const calls = [];
    const reader = createRobinhoodBundleFundingReader({
      candidateWallets: [WALLET.toUpperCase().replace('0X', '0x')],
      rpcClient: {
        async request(method, params) {
          calls.push([method, params]);
          return method === 'eth_chainId'
            ? '0x1237' : { number: params[0], hash: HASH_A };
        },
        async requestBatch(requests) {
          calls.push(['batch', requests]);
          return requests.map(({ params }) => fullBlock(BigInt(params[0])));
        },
      },
    });
    assert.equal(await reader.assertChain(), '4663');
    assert.equal(await reader.checkpoint('10'), HASH_A);
    const result = await reader.readBlocks(['10']);
    assert.equal(result.blocksScanned, 1);
    assert.equal(result.transfers.length, 1);
    assert.equal(result.candidateInboundTransfers, 1);
    assert.equal(result.candidateOutboundTransfers, 0);
    assert.deepEqual(result.transfers[0], {
      transactionHash: TX_HASH, transactionIndex: '0',
      fromAddress: FUNDER, toAddress: WALLET, valueWei: '10',
      blockNumber: '10', blockHash: HASH_A, blockTimestamp: '100',
    });
    assert.deepEqual(calls[2][1][0], {
      method: 'eth_getBlockByNumber', params: ['0xa', true],
    });
  });

  it('hydrates oversized full blocks from archive transaction hashes', async () => {
    const calls = [];
    const tooLarge = () => Object.assign(new Error('RPC error -32003'), {
      code: 'rpc_error', rpcCode: -32003,
    });
    const transactionHashes = Array.from({ length: 26 }, (_, index) => (
      `0x${String(index + 1).padStart(64, '0')}`
    ));
    const reader = createRobinhoodBundleFundingReader({
      candidateWallets: [WALLET],
      rpcClient: {
        async request(method, params) {
          calls.push([method, params]);
          if (params[0] === '0xb' && params[1] === true) throw tooLarge();
          if (params[0] === '0xb') return {
            number: '0xb', hash: HASH_A, timestamp: '0x64', transactions: transactionHashes,
          };
          return fullBlock(BigInt(params[0]));
        },
        async requestBatch(requests) {
          calls.push(['batch', requests]);
          if (requests[0].method === 'eth_getBlockByNumber') throw tooLarge();
          return requests.map(({ params }) => ({
            hash: params[0], transactionIndex: `0x${transactionHashes.indexOf(params[0]).toString(16)}`,
            from: FUNDER, to: WALLET, value: '0x1', blockNumber: '0xb', blockHash: HASH_A,
          }));
        },
      },
    });

    const result = await reader.readBlocks(['10', '11']);
    assert.equal(result.blocksScanned, 2);
    assert.equal(result.transfers.length, 27);
    assert.deepEqual(calls.map(([kind]) => kind), [
      'batch', 'eth_getBlockByNumber', 'eth_getBlockByNumber',
      'eth_getBlockByNumber', 'batch', 'batch',
    ]);
    assert.equal(calls[4][1].length, 25);
    assert.equal(calls[5][1].length, 1);
  });

  it('does not mask unrelated RPC failures or incoherent hydrated transactions', async () => {
    const unrelated = Object.assign(new Error('timeout'), {
      code: 'timeout', rpcCode: null,
    });
    const failing = createRobinhoodBundleFundingReader({ candidateWallets: [], rpcClient: {
      async request() {}, async requestBatch() { throw unrelated; },
    } });
    await assert.rejects(failing.readBlocks(['10']), (error) => error === unrelated);

    const tooLarge = Object.assign(new Error('RPC error -32003'), {
      code: 'rpc_error', rpcCode: -32003,
    });
    const incoherent = createRobinhoodBundleFundingReader({ candidateWallets: [], rpcClient: {
      async request(_method, params) {
        if (params[1] === true) throw tooLarge;
        return { number: '0xa', hash: HASH_A, timestamp: '0x64', transactions: [TX_HASH] };
      },
      async requestBatch(requests) {
        if (requests[0].method === 'eth_getBlockByNumber') throw tooLarge;
        return [{ ...fullBlock(11).transactions[0], blockNumber: '0xb', blockHash: HASH_B }];
      },
    } });
    await assert.rejects(incoherent.readBlocks(['10']), /from the wrong block/);
  });

  it('samples batches across every merged range and projects concurrent wall time', async () => {
    const workload = sampleBatches([
      { fromBlock: '10', toBlock: '15' }, { fromBlock: '100', toBlock: '101' },
    ], 2, 3);
    assert.equal(workload.batchCount, 4);
    assert.deepEqual(workload.samples, [['10', '11'], ['14', '15'], ['100', '101']]);
    const checkpoints = [HASH_A, HASH_A];
    const result = await preflightBundleFunding({
      ranges: [{ fromBlock: '10', toBlock: '15' }], sourceThroughBlock: '15',
      batchBlocks: 2, concurrency: 2, sampleCount: 2, maxHours: 5,
    }, {
      now: (() => { const values = [0, 100]; return () => values.shift(); })(),
      reader: {
        async assertChain() { return '4663'; },
        async checkpoint() { return checkpoints.shift(); },
        async readBlocks(numbers) {
          return { blocksScanned: numbers.length, payloadBytes: 20, transfers: [{}],
            candidateInboundTransfers: 1, candidateOutboundTransfers: 0 };
        },
      },
    });
    assert.equal(result.batchCount, 3);
    assert.equal(result.sampledBlocks, 4);
    assert.equal(result.projectedMs, 188);
    assert.equal(result.samplePayloadBytes, 40);
    assert.equal(result.approved, true);
  });

  it('fails closed on chain mismatch, checkpoint drift, and unsafe tuning', async () => {
    const wrongChain = createRobinhoodBundleFundingReader({
      candidateWallets: [], rpcClient: {
        async request() { return '0x1'; }, async requestBatch() { return []; },
      },
    });
    await assert.rejects(wrongChain.assertChain(), /does not match Robinhood/);
    const driftingHashes = [HASH_A, HASH_B];
    const checkpointDrift = await preflightBundleFunding({
      ranges: [{ fromBlock: '1', toBlock: '1' }], sourceThroughBlock: '1',
      batchBlocks: 1, concurrency: 1, sampleCount: 1,
    }, { now: (() => { let now = 0; return () => ++now; })(), reader: {
      async assertChain() { return '4663'; },
      async checkpoint() { return driftingHashes.shift(); },
      async readBlocks() { return { blocksScanned: 1, payloadBytes: 0, transfers: [],
        candidateInboundTransfers: 0, candidateOutboundTransfers: 0 }; },
    } });
    assert.equal(checkpointDrift.approved, false);
    await assert.rejects(preflightBundleFunding({
      ranges: [], batchBlocks: 101, concurrency: 1, sampleCount: 1,
    }, { reader: {} }), /batchBlocks/);
  });
});

describe('Robinhood bundle funding preflight command', () => {
  it('requires explicit lookback and builds a single archive-only provider', () => {
    assert.throws(() => parseArgs([]), /lookback-blocks is required/);
    assert.throws(() => parseArgs([
      '--lookback-blocks=1000', '--concurrency=9', '--samples=8',
    ]), /greater than or equal/);
    const options = parseArgs(['--lookback-blocks=1000', '--concurrency=16', '--samples=16']);
    assert.equal(options.lookbackBlocks, 1000);
    assert.equal(parseArgs([
      '--lookback-blocks=1000', '--baseline-run-id=7',
    ]).baselineRunId, '7');
    let captured;
    archiveClient({ RH_NODE_RPC_URL: 'http://127.0.0.1:8547' }, (value) => {
      captured = value; return {};
    });
    assert.deepEqual(captured.providers, [{
      name: 'robinhood-pc-archive', url: 'http://127.0.0.1:8547',
    }]);
  });

  it('freezes covered candidates and reports the archive preflight without writing', async () => {
    const loaded = { ready: true, anchorCoverageComplete: false, missingAnchorTokens: '5',
      completeThroughBlock: '102', candidates: [
        { tokenAddress: TOKEN, walletAddress: WALLET, launchBlock: '100',
          firstBuyBlock: '101', firstBuyTransactionIndex: '0' },
        { tokenAddress: TOKEN, walletAddress: FUNDER, launchBlock: '100',
          firstBuyBlock: '102', firstBuyTransactionIndex: '0' },
      ], candidateScope: 'incremental', fullCandidateRows: 10,
      baseline: { runId: '1', lookbackBlocks: '10' } };
    const report = await main([], {
      options: { lookbackBlocks: 10, sourceFromBlock: '0', statementTimeoutMs: 1000,
        batchBlocks: 2, concurrency: 1, sampleCount: 1, maxHours: 5 },
      env: { DATABASE_URL: 'postgres://test' }, source: { async load() { return loaded; } },
      reader: {}, logger: { log() {} },
      async preflight(input) { return { approved: true, chainId: '4663',
        sourceThroughBlock: input.sourceThroughBlock }; },
    });
    assert.equal(report.mode, 'preflight-read-only');
    assert.equal(report.candidateTokens, 1);
    assert.equal(report.candidateWallets, 2);
    assert.equal(report.candidateScope, 'incremental');
    assert.equal(report.baseline.runId, '1');
    assert.equal(report.missingAnchorTokens, '5');
    assert.equal(report.approved, true);
  });
});
