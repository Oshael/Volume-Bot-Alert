const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runStockMinuteReplay } = require('../src/services/robinhood-stock-minute-replay');
const archive = require('../src/utils/reconstruct-robinhood-v3-archive').__private;
const scope = require('../src/services/robinhood-archive-replay-scope');
const fixture = require('../data/fixtures/robinhood-uniswap-v2.json');
const BASE = Date.parse('2026-09-19T10:30:00Z') / 1000;
const HASH = `0x${'a'.repeat(64)}`;

function setup() {
  const options = { ...archive.parseArgs(['--target=stock-quote', '--mode=write',
    '--from-block=0', '--to-block=11', '--range-size=2', '--batch-size=1', '--sleep-ms=0'], {}),
  maintenancePaused: true, checkpointFile: '/unused.json' };
  const pool = { protocol: 'uniswap-v2', pool_address: fixture.swap.address,
    market_key: `robinhood:uniswap-v2:${fixture.swap.address}`, discovery_block: '0',
    token_address: `0x${'c'.repeat(40)}`, quote_address: scope.STOCKS[0] };
  let saved = null;
  const observed = new Set();
  const rebuilt = [];
  const logs = [1, 4, 6].map((block) => ({ ...fixture.swap,
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${String(block).padStart(64, '0')}`,
    blockHash: HASH, logIndex: '0x1', transactionIndex: '0x0' }));
  const deps = {
    logger: { log() {} },
    checkpoint: { load: async () => saved, save: async (value) => { saved = value; } },
    repository: { withLock: async (callback) => callback(), listPools: async () => [pool],
      classify: async (rows) => new Map(rows.map((row) => [
        `${row.transaction_hash}:${row.log_index}`, { observed: observed.has(row.transaction_hash) },
      ])) },
    rpcClient: { request: async (method, params) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getBlockByNumber') return {
        number: params[0], timestamp: `0x${(BASE + Number(BigInt(params[0])) * 12).toString(16)}`, hash: HASH,
      };
      const filter = params[0];
      return logs.filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock)
        && BigInt(log.blockNumber) <= BigInt(filter.toBlock));
    } },
    enrichBatch: async (rows) => ({ entries: rows.map((row) => ({ row, observation: { accepted: true } })) }),
    persistence: { commitHeadProcessingBatch: async ({ entries }) => {
      for (const entry of entries) observed.add(entry.row.transaction_hash);
    } },
    rebuild: async (rows, minute) => { rebuilt.push({ rows, minute }); return { minutes: 1, hours: 1 }; },
  };
  return { options, deps, observed, rebuilt, saved: () => saved };
}

describe('Stock archive replay by complete minutes', () => {
  it('rebuilds complete minutes across RPC/commit chunks and resumes without including the final partial minute', async () => {
    const test = setup();
    const first = await runStockMinuteReplay({ ...test.options, maxRanges: 1 }, test.deps);
    assert.equal(first.nextBlock, '5');
    assert.equal(first.complete, false);
    assert.deepEqual(test.rebuilt[0].rows.map((row) => row.block_number), ['1', '4']);
    const final = await runStockMinuteReplay(test.options, test.deps);
    assert.equal(final.complete, true);
    assert.equal(final.nextBlock, '10');
    assert.equal(final.minutes, 2);
    assert.equal(test.observed.size, 3);
    assert.equal(final.excludedEndMinute, '2026-09-19T10:32:00.000Z');
    test.deps.repository.listPools = async () => [];
    await assert.rejects(runStockMinuteReplay(test.options, test.deps), /poolDigest changed/);
  });

  it('rebuilds again after committed observations followed by a failed rebuild/checkpoint', async () => {
    const test = setup();
    const rebuild = test.deps.rebuild;
    test.deps.rebuild = async () => { throw new Error('rebuild interrupted'); };
    await assert.rejects(runStockMinuteReplay(test.options, test.deps), /rebuild interrupted/);
    assert.equal(test.saved(), null);
    assert.equal(test.observed.size, 2);
    test.deps.rebuild = rebuild;
    await runStockMinuteReplay({ ...test.options, maxRanges: 1 }, test.deps);
    assert.equal(test.rebuilt[0].rows.length, 2);
    assert.equal(test.observed.size, 2);
  });

  for (const [name, alter, pattern] of [
    ['partial start', (test) => { test.options.fromBlock = '1'; }, /first block of a minute/],
    ['unpaused maintenance', (test) => { test.options.maintenancePaused = false; }, /paused maintenance/],
    ['retained capture', (test) => { test.deps.repository.classify = async () => new Map([
      [`0x${'1'.padStart(64, '0')}:1`, { captured: true }],
    ]); }, /awaits retained capture/],
    ['incomplete enrichment', (test) => { test.deps.enrichBatch = async () => ({ entries: [] }); }, /incomplete/],
    ['unavailable quote', (test) => { test.deps.enrichBatch = async (rows) => ({
      entries: rows.map((row) => ({ row, observation: { accepted: false, reason: 'quote_usd_unavailable' } })),
    }); }, /remains pending/],
  ]) it(`does not advance or write on ${name}`, async () => {
    const test = setup();
    alter(test);
    await assert.rejects(runStockMinuteReplay(test.options, test.deps), pattern);
    assert.equal(test.saved(), null);
    assert.equal(test.observed.size, 0);
  });

  it('dry-run scans closed minutes without enrichment or bucket writes', async () => {
    const test = setup();
    test.deps.enrichBatch = async () => { throw new Error('unexpected enrichment'); };
    const result = await runStockMinuteReplay({ ...test.options, mode: 'dry-run', maintenancePaused: false }, test.deps);
    assert.equal(result.missing, 3);
    assert.equal(result.complete, true);
    assert.equal(test.observed.size, 0);
    assert.equal(test.rebuilt.length, 0);
  });
});
