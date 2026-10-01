const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { parseArgs, runCampaign, __private: { withCampaignLock } } = require('../src/utils/backfill-robinhood-stock-history');
const scope = require('../src/services/robinhood-archive-replay-scope');
const replay = require('../src/services/robinhood-stock-minute-replay');
const onboarding = require('../src/utils/backfill-robinhood-onboarding');
const captures = require('../src/utils/repair-robinhood-v3-pruned-captures');
const aggregates = require('../src/utils/backfill-robinhood-market-aggregates').__private;
const HASH = `0x${'a'.repeat(64)}`;
const BASE = Date.parse('2026-09-19T10:30:00Z') / 1000;
const TOKEN = `0x${'c'.repeat(40)}`;

function setup() {
  const options = parseArgs(['--mode=write', '--maintenance-paused', '--to-block=11', '--checkpoint-dir=/unused'], {
    ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive',
  });
  const pools = [{ protocol: 'uniswap-v2', pool_address: `0x${'b'.repeat(40)}`,
    market_key: 'pool', token_address: TOKEN, quote_address: scope.STOCKS[0], discovery_block: '0' }];
  const records = [];
  const calls = [];
  let saved;
  const deps = {
    logger: { log() {} }, withLock: async (_database, callback) => callback(),
    listCheckpoints: async () => [], now: () => (BASE + 3 * 86400) * 1000,
    checkpoint: { load: async () => saved, save: async (state) => { saved = structuredClone(state); records.push(saved); } },
    database: { query: async () => ({ rows: [{ name: 'stock_test', host: '127.0.0.1', port: 5432 }] }) },
    repository: { listPools: async () => pools },
    rpcClient: { request: async (method, params) => method === 'eth_chainId' ? '0x1237' : {
      number: params[0], hash: HASH, timestamp: `0x${(BASE + Number(BigInt(params[0])) * 12).toString(16)}`,
    } },
    steps: Object.fromEntries(['discovery', 'captures', 'minutes', 'aggregates'].map((phase) => [phase, async () => {
      calls.push(phase);
      return { done: true, patch: phase === 'discovery' ? {
        tokens: [TOKEN], poolDigest: scope.poolDigest(scope.poolIndex(pools, 'stock-quote', '11')),
      } : phase === 'aggregates' ? { tokenIndex: 1 } : {} };
    }])),
  };
  return { options, deps, records, calls, pools, saved: () => saved };
}

describe('Single Stock history campaign', () => {
  it('separates dry-run/write files, requires a fixed end and rejects mistyped bounds', () => {
    const base = ['--to-block=11', '--checkpoint-dir=/unused'];
    const env = { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive' };
    assert.equal(parseArgs(base, env).directory, '/unused/dry-run');
    assert.equal(parseArgs([...base, '--mode=write'], env).directory, '/unused/write');
    for (const extra of ['--max-minutes=no', '--rpc-concurrency=99', '--max-minute=1']) {
      assert.throws(() => parseArgs([...base, extra], env));
    }
    assert.throws(() => parseArgs(['--checkpoint-dir=/unused'], env), /to-block/);
  });

  it('pauses at a canary and resumes its stage without repeating completed discovery/repair', async () => {
    const test = setup();
    test.deps.steps.minutes = async () => { test.calls.push('minutes'); return { done: false, paused: true }; };
    const paused = await runCampaign(test.options, test.deps);
    assert.equal(paused.phase, 'minutes');
    assert.equal(paused.complete, false);
    test.deps.steps.minutes = async () => { test.calls.push('minutes'); return { done: true }; };
    const done = await runCampaign(test.options, test.deps);
    assert.equal(done.complete, true);
    assert.deepEqual(test.calls, ['discovery', 'captures', 'minutes', 'minutes', 'aggregates']);
    assert.equal(done.aggregateTo, '2026-09-20T10:32:00.000Z');
  });

  for (const phase of ['discovery', 'captures', 'minutes', 'aggregates']) {
    it(`does not skip ${phase} after a failure`, async () => {
      const test = setup();
      test.deps.steps[phase] = async () => { throw new Error('interrupted'); };
      await assert.rejects(runCampaign(test.options, test.deps), /interrupted/);
      assert.equal(test.saved().phase, phase);
    });
  }

  it('refuses orphan files, unpaused writes, changed database, catalog and branch', async () => {
    const orphan = setup();
    orphan.deps.listCheckpoints = async () => ['minutes.json'];
    await assert.rejects(runCampaign(orphan.options, orphan.deps), /orphan checkpoints/);
    await assert.rejects(runCampaign({ ...orphan.options, maintenancePaused: false }, orphan.deps), /maintenance-paused/);
    for (const alter of [
      (test) => { test.deps.database.query = async () => ({ rows: [{ name: 'another_test' }] }); },
      (test) => { test.pools[0].quote_address = scope.STOCKS[1]; },
      (test) => { const request = test.deps.rpcClient.request; test.deps.rpcClient.request = async (...args) => {
        const result = await request(...args); return typeof result === 'object' ? { ...result, hash: `0x${'b'.repeat(64)}` } : result;
      }; },
    ]) {
      const test = setup();
      await runCampaign(test.options, test.deps);
      alter(test);
      await assert.rejects(runCampaign(test.options, test.deps), /changed/);
    }
  });

  it('rejects corrupted checkpoint bounds before resuming writes', async () => {
    for (const patch of [{ closedToBlock: '11' }, { tokenIndex: 0 }, { aggregateTo: 'invalid' }]) {
      const test = setup();
      await runCampaign(test.options, test.deps);
      Object.assign(test.saved(), patch);
      const before = test.calls.length;
      await assert.rejects(runCampaign(test.options, test.deps), /changed|skipped|invalid/);
      assert.equal(test.calls.length, before);
    }
  });

  it('discards the connection if PostgreSQL cannot release its campaign lock', async () => {
    let discarded;
    const client = { query: async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      throw new Error('unlock failed');
    }, release: (value) => { discarded = value; } };
    await assert.rejects(withCampaignLock({ getClient: async () => client }, async () => 'ready'), /unlock failed/);
    assert.equal(discarded, true);
  });

  it('wires isolated checkpoints, closed capture bounds and token-scoped aggregates through the real coordinator', async (t) => {
    const test = setup();
    delete test.deps.steps;
    mock.method(onboarding, 'backfillStockPairs', async (options) => {
      assert.equal(options.fromBlock, '0'); assert.equal(options.confirm, true);
      assert.equal(options.stockCheckpointFile, '/unused/write/discovery.json'); return {};
    });
    mock.method(captures, 'runRepair', async (options) => {
      assert.equal(options.toBlock, '9'); assert.equal(options.target, 'stock-quote');
      return { complete: true, blocked: 0 };
    });
    mock.method(replay, 'runStockMinuteReplay', async (options, deps) => {
      assert.equal(options.checkpointFile, '/unused/write/minutes.json');
      assert.equal(deps.checkpoint, undefined); return { complete: true };
    });
    mock.method(aggregates, 'runBackfill', async (options) => {
      assert.equal(options.tokenAddress, TOKEN); assert.equal(options.tokenLimit, 1);
      assert.equal(options.to.toISOString(), '2026-09-20T10:32:00.000Z'); return { paused: false };
    });
    t.after(() => mock.restoreAll());
    const result = await runCampaign(test.options, test.deps);
    assert.equal(result.complete, true);
    assert.equal(result.tokenIndex, 1);
    const blocked = setup();
    delete blocked.deps.steps;
    mock.method(captures, 'runRepair', async () => ({ complete: true, blocked: 1 }));
    await assert.rejects(runCampaign(blocked.options, blocked.deps), /capture repair is incomplete/);
    assert.equal(blocked.saved().phase, 'captures');
  });
});
