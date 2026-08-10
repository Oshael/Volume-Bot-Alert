const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  loadCatalogScope,
  normalizeOptions,
  resolveProvider,
  runHolderTransferProbe,
} = require('../src/utils/robinhood-holder-transfer-probe');

const TOKEN = '0x1111111111111111111111111111111111111111';
const ALICE = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;
const BOB = `0x${'0'.repeat(24)}${'3'.repeat(40)}`;

function transfer(from, to, index = 1) {
  return {
    address: TOKEN,
    transactionHash: `0x${String(index).padStart(64, '0')}`,
    logIndex: `0x${index.toString(16)}`,
    topics: [TRANSFER_TOPIC, from, to],
    data: `0x${'1'.padStart(64, '0')}`,
  };
}

function createClient(options = {}) {
  const calls = [];
  return {
    calls,
    getMetrics: () => ({ 'holder-transfer-probe': { eth_getLogs: { requests: 3 } } }),
    async requestProvider(_provider, method, params = []) {
      calls.push({ method, params });
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return options.head || '0xa';
      if (method === 'eth_getBlockByNumber') {
        return { timestamp: params[0] === '0x7' ? '0x64' : '0x190' };
      }
      if (method !== 'eth_getLogs') throw new Error(`unexpected method ${method}`);
      const filter = params[0];
      if (options.split && filter.fromBlock === '0x1' && filter.toBlock === '0x4') {
        const error = new Error('range too large');
        error.code = 'log_range_error';
        throw error;
      }
      return options.logs?.(filter) || [];
    },
  };
}

describe('Robinhood holder Transfer probe', () => {
  it('bounds its read-only window and prefers the dedicated or dRPC endpoint', () => {
    assert.deepEqual(normalizeOptions({ blockCount: 999999, chunkBlocks: 0 }), {
      confirmations: 2, blockCount: 50_000, chunkBlocks: 1, timeoutMs: 15_000,
      ledgerRowBytes: 160, tailEventBytes: 220, addressBatchSize: 100,
      catalogLimit: 1000, fromBlock: null,
    });
    assert.equal(resolveProvider({ ROBINHOOD_DRPC_RPC_URL: 'https://drpc.test' }).source, 'drpc');
    assert.equal(resolveProvider({
      ROBINHOOD_HOLDER_TRANSFER_PROBE_RPC_URL: 'https://probe.test',
      ROBINHOOD_DRPC_RPC_URL: 'https://drpc.test',
    }).source, 'probe');
    assert.equal(resolveProvider({
      ROBINHOOD_RPC_URL: 'http://node.test', ROBINHOOD_DRPC_RPC_URL: 'https://drpc.test',
    }).source, 'robinhood-config');
  });

  it('loads a bounded recent catalog scope using read-only selects', async () => {
    const calls = [];
    const database = { query: async (sql, params) => {
      calls.push({ sql, params });
      return /COUNT/.test(sql)
        ? { rows: [{ total: '3' }] }
        : { rows: [{ address: TOKEN }, { address: TOKEN.toUpperCase().replace('0X', '0x') }] };
    } };
    const scope = await loadCatalogScope(database, 2);
    assert.deepEqual(scope, { total: 3, addresses: [TOKEN] });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /SELECT COUNT/);
    assert.match(calls[1].sql, /ORDER BY last_seen_at DESC/);
    assert.deepEqual(calls[1].params, [2]);
  });

  it('measures tokens, wallets, pairs and storage projections without writes', async () => {
    const client = createClient({ logs: ({ fromBlock }) => fromBlock === '0x7'
      ? [transfer(ZERO_TOPIC, ALICE, 1), transfer(ALICE, BOB, 2)]
      : [transfer(BOB, ZERO_TOPIC, 3)] });
    const report = await runHolderTransferProbe({
      client, provider: { name: 'holder-transfer-probe', source: 'test', url: 'x' },
      confirmations: 0, blockCount: 4, chunkBlocks: 2,
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.events, 3);
    assert.equal(report.tokens, 1);
    assert.equal(report.wallets, 2);
    assert.equal(report.tokenWalletPairsTouched, 2);
    assert.equal(report.mints, 1);
    assert.equal(report.burns, 1);
    assert.equal(report.deploymentEvidence.exactDeploymentBlockAvailable, false);
    assert.equal(report.deploymentEvidence.coveragePct, 100);
    assert.ok(report.projected.eventsPerDay > report.events);
    assert.ok(client.calls.every(({ method }) => ['eth_chainId', 'eth_blockNumber',
      'eth_getBlockByNumber', 'eth_getLogs'].includes(method)));
  });

  it('splits provider range failures and counts malformed evidence', async () => {
    const client = createClient({
      head: '0x4', split: true,
      logs: ({ fromBlock }) => fromBlock === '0x1'
        ? [transfer(ZERO_TOPIC, ALICE), { address: TOKEN, topics: [], data: '0x' }]
        : [],
    });
    const report = await runHolderTransferProbe({
      client, provider: { name: 'holder-transfer-probe', source: 'test', url: 'x' },
      confirmations: 0, fromBlock: 1, chunkBlocks: 4,
    });

    assert.equal(report.events, 1);
    assert.equal(report.malformed, 1);
    assert.equal(report.telemetry.splits, 1);
    assert.equal(report.telemetry.requests, 3);
    assert.equal(report.telemetry.largestSuccessfulRange, 2);
    assert.equal(report.telemetry.errors.log_range_error, 1);
  });

  it('filters catalog transfers in bounded address batches', async () => {
    const token2 = '0x2222222222222222222222222222222222222222';
    const client = createClient();
    const report = await runHolderTransferProbe({
      client, provider: { name: 'holder-transfer-probe', source: 'node', url: 'x' },
      confirmations: 0, blockCount: 2, chunkBlocks: 2,
      addresses: [TOKEN, token2], catalogTotal: 4, addressBatchSize: 1,
    });
    const filters = client.calls.filter(({ method }) => method === 'eth_getLogs')
      .map(({ params }) => params[0].address);
    assert.deepEqual(filters, [[TOKEN], [token2]]);
    assert.deepEqual(report.scope, {
      kind: 'catalog', selectedTokens: 2, catalogTotal: 4,
      coveragePct: 50, addressBatchSize: 1, addressBatches: 2,
    });

    const emptyClient = createClient();
    const empty = await runHolderTransferProbe({
      client: emptyClient,
      provider: { name: 'holder-transfer-probe', source: 'node', url: 'x' },
      confirmations: 0, blockCount: 2, addresses: [], catalogTotal: 0,
    });
    assert.equal(empty.scope.kind, 'catalog');
    assert.equal(empty.events, 0);
    assert.equal(emptyClient.calls.some(({ method }) => method === 'eth_getLogs'), false);
  });
});
