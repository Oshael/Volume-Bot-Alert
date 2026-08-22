const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRobinhoodHolderLaunchSource,
  __private,
} = require('../src/models/robinhood-holder-launch-source');

const TOKEN = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const TX = `0x${'33'.repeat(32)}`;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const FRONTIER_HASH = `0x${'55'.repeat(32)}`;

function stateRow(overrides = {}) {
  return {
    ledger_status: 'live',
    deployment_block: '1',
    attribution_block: '1',
    first_pool_discovery_block: '100',
    live_through_block: '200',
    live_through_hash: FRONTIER_HASH,
    creator_address: null,
    ...overrides,
  };
}

function swapRow(overrides = {}) {
  return {
    wallet_address: WALLET,
    transaction_hash: TX,
    action_index: '0',
    transaction_index: '1',
    block_number: '101',
    block_hash: BLOCK_HASH,
    block_time: '2026-08-21T12:00:00.000Z',
    side: 'buy',
    volume_usd: '25.50',
    ...overrides,
  };
}

function coverage(overrides = {}) {
  return {
    ready: true,
    historicalFromBlock: '90',
    completeThroughBlock: '220',
    ...overrides,
  };
}

function sourceFixture(input = {}) {
  const queries = [];
  const database = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM robinhood_holder_token_states state')) {
        return { rows: input.stateRows ?? [stateRow()] };
      }
      if (sql.includes('WITH registered_swaps')) {
        return { rows: input.launchRows ?? [swapRow()] };
      }
      if (sql.includes('WITH registered_buys')) {
        return { rows: input.buyRows ?? [swapRow()] };
      }
      if (sql.includes('SELECT address, reason FROM')) {
        return { rows: input.exclusionRows ?? [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const coverageSource = {
    async loadBackfillFrontier() {
      return input.coverage ?? coverage();
    },
  };
  return {
    queries,
    source: createRobinhoodHolderLaunchSource({ database, coverageSource }),
  };
}

test('normalizes holder state and validates historical coverage boundaries', () => {
  assert.deepEqual(__private.normalizeState(stateRow(), TOKEN), {
    ready: true,
    tokenAddress: TOKEN,
    creatorAddress: null,
    launchFromBlock: '100',
    frontier: { blockNumber: '200', blockHash: FRONTIER_HASH },
  });
  const state = __private.normalizeState(stateRow(), TOKEN);
  assert.equal(
    __private.validateCoverage(state, coverage({ historicalFromBlock: '101' })).reason,
    'swap_coverage_starts_after_first_pool'
  );
  assert.equal(__private.normalizeState(stateRow({
    first_pool_discovery_block: null,
  }), TOKEN).reason, 'registered_pool_unavailable');
  assert.equal(
    __private.validateCoverage(state, coverage({ completeThroughBlock: '199' })).reason,
    'swap_coverage_behind_holder_frontier'
  );
});

test('reads canonical anchor and first buy evidence without classifying the wallet', async () => {
  const { source, queries } = sourceFixture();
  const result = await source.loadLaunchEvidence(TOKEN.toUpperCase());

  assert.equal(result.ready, true);
  assert.equal(result.anchor.blockNumber, '101');
  assert.equal(result.firstBuys.length, 1);
  assert.equal(result.firstBuys[0].withinLaunchWindow, true);
  assert.equal(result.firstBuys[0].volumeUsd, '25.50');
  assert.equal(Object.hasOwn(result.firstBuys[0], 'tag'), false);
  assert.deepEqual(result.window, { maxBlocks: 3, maxSeconds: 90 });
  assert.deepEqual(result.exclusions.map(({ walletAddress }) => walletAddress), [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ]);
  assert.deepEqual(queries.map(({ params }) => params), [
    ['robinhood', TOKEN],
    ['robinhood', TOKEN, '100', '200'],
    ['robinhood', TOKEN, '100', '200'],
    ['robinhood', TOKEN, null, '200', JSON.stringify([{
      wallet_address: WALLET, block_number: '101',
    }])],
  ]);
  assert.match(queries[3].sql, /valid_from_block <= candidate\.block_number/);
  assert.match(queries[0].sql, /MIN\(discovery_block\).*first_pool_discovery_block/s);
  assert.match(queries[1].sql, /registry\.discovery_block <= swap\.block_number/);
  assert.match(queries[2].sql, /MIN\(block_number\).*GROUP BY wallet_address/s);
});

test('fails closed before swap reads when complete history does not cover launch', async () => {
  const { source, queries } = sourceFixture({
    coverage: coverage({ historicalFromBlock: '102' }),
  });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.deepEqual(result, {
    ready: false,
    reason: 'swap_coverage_starts_after_first_pool',
    tokenAddress: TOKEN,
  });
  assert.equal(queries.length, 1);
});

test('fails closed when a canonical transaction position is absent', async () => {
  const { source, queries } = sourceFixture({
    launchRows: [swapRow({ transaction_index: null, block_hash: null })],
  });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'transaction_position_unavailable');
  assert.equal(queries.length, 2);
});

test('returns unavailable when no registered pool swap exists at the frontier', async () => {
  const { source, queries } = sourceFixture({ launchRows: [] });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'launch_swap_unavailable');
  assert.equal(queries.length, 2);
});
