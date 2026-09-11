'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ROLLBACK_DOMAINS, createRobinhoodChainRecoveryPlanner,
} = require('../src/services/robinhood-chain-recovery-planner');

const hash = (character) => `0x${character.repeat(64)}`;
const local = (number, character) => ({ blockNumber: String(number), blockHash: hash(character) });
const remote = (number, character, parent = '0') => ({
  number: `0x${number.toString(16)}`, hash: hash(character), parentHash: hash(parent),
});
function fixture(overrides = {}) {
  const calls = []; const localHeaders = overrides.localHeaders || [
    local(100, 'a'), local(99, 'b'), local(98, 'c'),
  ];
  const remoteHeaders = overrides.remoteHeaders || new Map([
    [100, remote(100, 'd', 'e')], [99, remote(99, 'e', 'c')], [98, remote(98, 'c')],
  ]);
  const cursor = {
    checkpoint_block: '100', checkpoint_hash: hash('a'), finalized_head: '98', generation: '7',
    ...overrides.cursor,
  };
  return {
    cursor, calls,
    journal: {
      getCursor: async () => cursor,
      listCanonicalHeaders: async (range) => { calls.push(['local', range]); return localHeaders; },
    },
    rpcClient: { request: async (method, [tag, hydrated]) => {
      const number = Number(BigInt(tag)); calls.push(['rpc', number, method, hydrated]);
      return remoteHeaders.get(number);
    } },
  };
}
function incoming(parentHash = hash('d')) {
  return { blockNumber: '101', blockHash: hash('f'), parentHash };
}

test('planner skips recovery when the incoming block extends the checkpoint', async () => {
  const deps = fixture();
  const planner = createRobinhoodChainRecoveryPlanner(deps, { maxDepth: 8 });
  assert.deepEqual(await planner.plan({ incoming: incoming(hash('a')) }), {
    status: 'extends-checkpoint', recoveryRequired: false, plan: null,
  });
  assert.deepEqual(deps.calls, []);
});

test('planner finds a bounded ancestor but keeps execution gated by rollback domains', async () => {
  const deps = fixture();
  const planner = createRobinhoodChainRecoveryPlanner(deps, { maxDepth: 8 });
  const result = await planner.plan({ incoming: incoming() });
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(result.plan, {
    generation: '7', maxDepth: 8,
    checkpoint: { blockNumber: '100', blockHash: hash('a') },
    incoming: { blockNumber: '101', blockHash: hash('f'), parentHash: hash('d') },
    finalizedBoundary: { blockNumber: '98' }, rollbackManifestVersion: 2,
    pendingRollbackDomains: [
      'wallet-derived', 'liquidity', 'holders', 'discovery-creator',
    ],
    executable: false,
    reason: 'parent_hash_mismatch', recoverable: true,
    ancestor: { blockNumber: '98', blockHash: hash('c') },
    affectedRange: { fromBlock: '99', throughBlock: '100', depth: '2' },
  });
  assert.deepEqual(deps.calls.slice(1), [
    ['rpc', 100, 'eth_getBlockByNumber', false],
    ['rpc', 99, 'eth_getBlockByNumber', false],
    ['rpc', 98, 'eth_getBlockByNumber', false],
  ]);
});

test('planner refuses a reorg that crosses the finalized boundary', async () => {
  const deps = fixture({ cursor: { finalized_head: '99' } });
  const result = await createRobinhoodChainRecoveryPlanner(deps).plan({ incoming: incoming() });
  assert.equal(result.plan.reason, 'finalized_boundary_crossed');
  assert.equal(result.plan.recoverable, false);
  assert.equal(result.plan.executable, false);
});

test('planner stops at its depth and fails closed without a common ancestor', async () => {
  const deps = fixture({
    localHeaders: [local(100, 'a'), local(99, 'b'), local(98, 'c')],
    remoteHeaders: new Map([
      [100, remote(100, 'd', 'e')], [99, remote(99, 'e', 'f')], [98, remote(98, 'f')],
    ]),
  });
  const result = await createRobinhoodChainRecoveryPlanner(deps, { maxDepth: 2 })
    .plan({ incoming: incoming() });
  assert.equal(result.plan.reason, 'ancestor_not_found');
  assert.equal(result.plan.recoverable, false);
  assert.equal(result.plan.ancestor, null);
  assert.equal(deps.calls.filter(([kind]) => kind === 'rpc').length, 3);
});

test('planner fails closed when the RPC head changes during planning', async () => {
  const deps = fixture({ remoteHeaders: new Map([[100, remote(100, 'e')]]) });
  await assert.rejects(
    createRobinhoodChainRecoveryPlanner(deps).plan({ incoming: incoming() }),
    (error) => error.code === 'capture_recovery_source_changed'
  );
});

test('rollback inventory is unique and keeps unfinished domains behind the gate', () => {
  assert.deepEqual(ROLLBACK_DOMAINS.map(({ id }) => id), [
    'canonical-journal', 'market', 'wallet', 'wallet-derived', 'liquidity', 'holders',
    'discovery-creator', 'publication-alerts',
  ]);
  assert.deepEqual(ROLLBACK_DOMAINS.filter(({ rollbackRegistered }) => !rollbackRegistered)
    .map(({ id }) => id), [
    'wallet-derived', 'liquidity', 'holders', 'discovery-creator',
  ]);
  const tables = ROLLBACK_DOMAINS.flatMap(({ tables }) => tables);
  assert.equal(new Set(tables).size, tables.length);
  for (const required of [
    'robinhood_chain_capture_cursor', 'robinhood_market_observations',
    'robinhood_wallet_swaps', 'robinhood_holder_cursors',
    'robinhood_pool_liquidity_event_cursors', 'token_catalog',
    'robinhood_wallet_swap_realtime_outbox',
  ]) {
    assert.equal(tables.includes(required), true, required);
  }
});
