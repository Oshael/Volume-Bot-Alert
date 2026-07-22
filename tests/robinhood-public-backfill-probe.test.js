const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DISCOVERY_FILTER,
  MARKET_FILTER,
  parseRangeSizes,
  rangeBounds,
  runPublicBackfillProbe,
} = require('../src/utils/robinhood-public-backfill-probe');

function createClient(options = {}) {
  const calls = [];
  const client = {
    providers: ['robinhood-public'],
    async request(method, params) {
      calls.push({ kind: 'request', method, params });
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return '0x3e8';
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x10' };
      if (method === 'eth_call') return '0x01';
      if (method === 'eth_getLogs') {
        if (options.failRangeSize) {
          const from = BigInt(params[0].fromBlock);
          const to = BigInt(params[0].toBlock);
          if (Number(to - from + 1n) === options.failRangeSize) {
            const error = new Error('eth_getLogs timeout');
            error.code = 'timeout';
            throw error;
          }
        }
        return [{ blockNumber: params[0].fromBlock }];
      }
      throw new Error(`Unexpected method ${method}`);
    },
    async requestBatch(requests) {
      calls.push({ kind: 'batch', requests });
      return requests.map(() => ({ timestamp: '0x10' }));
    },
    getMetrics() {
      return { 'robinhood-public': { eth_getLogs: { requests: 4 } } };
    },
  };
  return { client, calls };
}

function createRepository() {
  const reads = [];
  return {
    reads,
    async loadCursor(stream) {
      reads.push(stream);
      return { next_block: stream === 'discovery' ? '100' : '200' };
    },
  };
}

describe('Robinhood public backfill probe', () => {
  it('parses unique bounded range sizes and rejects an empty invalid list', () => {
    assert.deepEqual(parseRangeSizes('100, 500,100,5000'), [100, 500, 5000]);
    assert.deepEqual(rangeBounds(100n, 25, 1, 200n), { fromBlock: 125n, toBlock: 149n });
    assert.equal(rangeBounds(201n, 25, 0, 200n), null);
    assert.throws(() => parseRangeSizes('0,-1,20000,nope'), /no valid ranges/);
  });

  it('uses persisted cursors and probes public discovery and market filters without writes', async () => {
    const { client, calls } = createClient();
    const repository = createRepository();
    const report = await runPublicBackfillProbe({
      client,
      repository,
      rangeSizes: [100, 250],
      samples: 1,
      confirmations: 2,
    });

    assert.equal(report.complete, true);
    assert.deepEqual(repository.reads.sort(), ['discovery', 'market']);
    assert.equal(report.streams.discovery.ranges.length, 2);
    assert.equal(report.streams.market.ranges.length, 2);
    const logCalls = calls.filter((call) => call.method === 'eth_getLogs');
    assert.equal(logCalls.length, 4);
    assert.deepEqual(logCalls[0].params[0].address, DISCOVERY_FILTER.address);
    assert.deepEqual(logCalls[0].params[0].topics, DISCOVERY_FILTER.topics);
    assert.equal('address' in logCalls[2].params[0], false);
    assert.deepEqual(logCalls[2].params[0].topics, MARKET_FILTER.topics);
    assert.equal(calls.filter((call) => call.kind === 'batch').length, 2);
    assert.deepEqual(report.rpc, { eth_getLogs: { requests: 4 } });
  });

  it('continues the matrix after an isolated public range failure', async () => {
    const { client } = createClient({ failRangeSize: 100 });
    const report = await runPublicBackfillProbe({
      client,
      repository: createRepository(),
      rangeSizes: [100, 250],
      samples: 1,
    });

    assert.equal(report.complete, false);
    assert.equal(report.streams.discovery.ranges[0].ok, false);
    assert.equal(report.streams.discovery.ranges[0].error.code, 'timeout');
    assert.equal(report.streams.discovery.ranges[1].ok, true);
    assert.equal(report.streams.market.ranges[1].ok, true);
  });

  it('refuses a client that could silently include a fallback provider', async () => {
    await assert.rejects(
      () => runPublicBackfillProbe({
        client: { providers: ['robinhood-public', 'alchemy-free'] },
        repository: createRepository(),
      }),
      /requires exactly the robinhood-public provider/
    );
  });
});
