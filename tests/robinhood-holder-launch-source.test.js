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
      if (sql.includes('SELECT swap.block_number::text, swap.block_time')) {
        return { rows: input.launchPointRows ?? [{
          block_number: '101', block_time: '2026-08-21T12:00:00.000Z',
        }] };
      }
      if (sql.includes("DATE_TRUNC('day', $4::timestamptz)")) {
        return { rows: input.launchRows ?? [swapRow()] };
      }
      if (sql.includes('INSERT INTO robinhood_token_launch_anchors')) return { rows: [] };
      if (sql.includes('FROM robinhood_wallet_token_first_buys buy')) {
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
    source: createRobinhoodHolderLaunchSource({
      database, coverageSource, firstBuyLimit: input.firstBuyLimit,
      minimumFirstBuyNotionalUsd: input.minimumFirstBuyNotionalUsd,
      candidateMaxBlocks: input.candidateMaxBlocks,
    }),
  };
}

test('normalizes holder state and validates historical coverage boundaries', () => {
  assert.deepEqual(__private.normalizeState(stateRow(), TOKEN), {
    ready: true,
    tokenAddress: TOKEN,
    creatorAddress: null,
    launchFromBlock: '100',
    launchPoint: null,
    cachedAnchor: null,
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
    ['robinhood', TOKEN, '101', '2026-08-21T12:00:00.000Z'],
    [
      'robinhood', TOKEN, '100', '101', '2026-08-21T12:00:00.000Z', '200',
      'rh_launch_anchor_v1', WALLET, TX, '1', '0', BLOCK_HASH, 'buy', '25.50',
    ],
    ['robinhood', TOKEN, '100', '200', null],
    ['robinhood', TOKEN, null, '200', JSON.stringify([{
      wallet_address: WALLET, block_number: '101',
    }])],
  ]);
  assert.match(queries[5].sql, /valid_from_block <= candidate\.block_number/);
  assert.doesNotMatch(queries[5].sql, /robinhood_wallet_swaps/);
  assert.doesNotMatch(queries[5].sql, /router_address/);
  assert.match(queries[0].sql, /MIN\(discovery_block\).*first_pool_discovery_block/s);
  assert.match(queries[1].sql, /ORDER BY swap\.block_time/);
  assert.match(queries[2].sql, /DATE_TRUNC\('day'/);
  assert.match(queries[4].sql, /robinhood_wallet_token_first_buys/);
  assert.match(queries[4].sql, /LIMIT \$5::int/);
  assert.doesNotMatch(queries.map(({ sql }) => sql).join('\n'), /registered_swaps/);
});

test('limits high-confidence first-buy reads to canonical buyer rank', async () => {
  const { source, queries } = sourceFixture({ firstBuyLimit: 5 });
  assert.equal((await source.loadLaunchEvidence(TOKEN)).ready, true);
  assert.equal(queries[4].params[4], 5);
  assert.throws(() => sourceFixture({ firstBuyLimit: 0 }), /firstBuyLimit/);
});

test('skips raw launch and router reads when top-five buys miss the notional floor', async () => {
  const { source, queries } = sourceFixture({
    firstBuyLimit: 5, minimumFirstBuyNotionalUsd: '50', candidateMaxBlocks: 1,
    buyRows: [swapRow({ volume_usd: '49.99' })],
  });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, true);
  assert.equal(result.anchor, null);
  assert.deepEqual(result.firstBuys, []);
  assert.deepEqual(queries.map(({ params }) => params), [
    ['robinhood', TOKEN], ['robinhood', TOKEN, '100', '200', 5],
  ]);
  assert.equal(queries.some(({ sql }) => /robinhood_wallet_swaps/.test(sql)), false);
  assert.throws(() => sourceFixture({
    minimumFirstBuyNotionalUsd: '50',
  }), /requires firstBuyLimit/);
});

test('hydrates the canonical anchor only for a plausible high-confidence buy', async () => {
  const { source, queries } = sourceFixture({
    firstBuyLimit: 5, minimumFirstBuyNotionalUsd: '50', candidateMaxBlocks: 1,
    buyRows: [swapRow({ volume_usd: '50' })],
  });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, true);
  assert.equal(result.anchor.transactionHash, TX);
  assert.equal(queries[1].params[4], 5);
  assert.match(queries[2].sql, /ORDER BY swap\.block_time/);
  assert.match(queries[3].sql, /DATE_TRUNC\('day'/);
});

test('skips typed anchor hydration when cached launch distance exceeds one block', async () => {
  const { source, queries } = sourceFixture({
    firstBuyLimit: 5, minimumFirstBuyNotionalUsd: '50', candidateMaxBlocks: 1,
    stateRows: [stateRow({
      cached_launch_block: '101',
      cached_launch_block_time: '2026-08-21T12:00:00.000Z',
    })],
    buyRows: [swapRow({ block_number: '103', volume_usd: '100' })],
  });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, true);
  assert.equal(result.anchor, null);
  assert.deepEqual(queries.map(({ params }) => params), [
    ['robinhood', TOKEN], ['robinhood', TOKEN, '100', '200', 5],
  ]);
  assert.equal(queries.some(({ sql }) => /DATE_TRUNC\('day'/.test(sql)), false);
});

test('reuses complete cached anchor evidence without reading raw launch swaps', async () => {
  const { source, queries } = sourceFixture({
    stateRows: [stateRow({
      cached_launch_block: '101',
      cached_launch_block_time: '2026-08-21T12:00:00.000Z',
      anchor_wallet_address: WALLET,
      anchor_transaction_hash: TX,
      anchor_transaction_index: '1',
      anchor_action_index: '0',
      anchor_block_hash: BLOCK_HASH,
      anchor_side: 'buy',
      anchor_volume_usd: '25.50',
    })],
  });
  assert.equal((await source.loadLaunchEvidence(TOKEN)).ready, true);
  assert.equal(queries.some(({ sql }) => /ORDER BY swap\.block_time/.test(sql)), false);
  assert.equal(queries.some(({ sql }) => /DATE_TRUNC\('day'/.test(sql)), false);
  assert.equal(queries.some(({ sql }) => /INSERT INTO robinhood_token_launch_anchors/.test(sql)),
    false);
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
  assert.equal(queries.length, 3);
});

test('returns unavailable when no registered pool swap exists at the frontier', async () => {
  const { source, queries } = sourceFixture({ launchPointRows: [] });
  const result = await source.loadLaunchEvidence(TOKEN);

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'launch_swap_unavailable');
  assert.equal(queries.length, 2);
});
