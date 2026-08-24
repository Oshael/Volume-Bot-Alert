const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBundleFundingCandidateSource,
  __private: { ANCHOR_COVERAGE_SQL, CANDIDATES_SQL },
} = require('../src/models/robinhood-bundle-funding-candidate-source');
const {
  main, parseArgs,
} = require('../src/utils/plan-robinhood-bundle-funding');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;

function database(coverage, candidates = [], anchorCoverage = {
  live_tokens: '12', first_buy_tokens: '10', anchored_tokens: '10',
}) {
  const calls = [];
  return {
    calls,
    queryWithStatementTimeout: async (sql, params, timeout) => {
      calls.push({ sql, params, timeout });
      if (sql === CANDIDATES_SQL) return { rows: candidates };
      if (sql === ANCHOR_COVERAGE_SQL) return { rows: [anchorCoverage] };
      return { rows: coverage ? [coverage] : [] };
    },
  };
}

describe('Robinhood bundle funding candidate source', () => {
  it('loads canonical launch + 3 candidates only after complete coverage', async () => {
    const db = database({
      source_next_block: '201', caught_up: true, seed_status: 'completed',
    }, [{
      token_address: TOKEN, wallet_address: WALLET, launch_block: '100',
      first_buy_block: '103', first_buy_transaction_index: '4',
    }]);
    const source = createRobinhoodBundleFundingCandidateSource({
      database: db, statementTimeoutMs: 5_000,
    });
    const result = await source.load();

    assert.equal(result.ready, true);
    assert.equal(result.completeThroughBlock, '200');
    assert.deepEqual(result.candidates[0], {
      tokenAddress: TOKEN, walletAddress: WALLET, launchBlock: '100',
      firstBuyBlock: '103', firstBuyTransactionIndex: '4',
    });
    assert.equal(result.firstBuyTokens, '10');
    assert.equal(result.liveTokens, '12');
    assert.equal(result.tokensWithoutFirstBuy, '2');
    assert.equal(result.anchorCoverageComplete, true);
    assert.equal(db.calls.length, 3);
    assert.equal(db.calls.every(({ timeout }) => timeout === 5_000), true);
    assert.match(db.calls[1].sql, /robinhood_holder_token_states/);
    assert.match(db.calls[1].sql, /COUNT\(DISTINCT live\.token_address\)/);
    assert.match(db.calls[1].sql, /state\.ledger_status = 'live'/);
    assert.match(db.calls[1].sql, /state\.live_through_block <= \$2::bigint/);
    assert.equal(db.calls[2].params[2], 500_001);
    assert.match(db.calls[2].sql, /anchor\.launch_block \+ 3/);
    assert.match(db.calls[2].sql, /robinhood_holder_token_states/);
    assert.match(db.calls[2].sql, /state\.ledger_status = 'live'/);
    assert.match(db.calls[2].sql, /buy\.block_number <= state\.live_through_block/);
    assert.match(db.calls[2].sql, /robinhood_infrastructure_registry/);
    assert.match(db.calls[2].sql, /token_wallets >= 2/);
  });

  it('reports missing anchors without blocking covered tokens', async () => {
    const db = database({
      source_next_block: '201', caught_up: true, seed_status: 'completed',
    }, [], { live_tokens: '12', first_buy_tokens: '10', anchored_tokens: '9' });
    const result = await createRobinhoodBundleFundingCandidateSource({ database: db }).load();

    assert.equal(result.ready, true);
    assert.equal(result.missingAnchorTokens, '1');
    assert.equal(result.anchorCoverageComplete, false);
    assert.equal(db.calls.some(({ sql }) => sql === CANDIDATES_SQL), true);
  });

  it('fails closed when the bounded candidate read reaches its memory cap', async () => {
    const db = database({
      source_next_block: '201', caught_up: true, seed_status: 'completed',
    }, [{}, {}, {}]);
    const result = await createRobinhoodBundleFundingCandidateSource({
      database: db, maxCandidateRows: 2,
    }).load();

    assert.equal(result.ready, false);
    assert.equal(result.reason, 'bundle_candidate_memory_cap_exceeded');
    assert.equal(result.observedCandidateRows, '3');
  });

  it('fails closed before candidate selection when first-buy coverage is incomplete', async () => {
    const cases = [
      [null, 'first_buy_cursor_unavailable'],
      [{ source_next_block: '201', caught_up: true, seed_status: 'running' },
        'first_buy_seed_incomplete'],
      [{ source_next_block: '201', caught_up: false, seed_status: 'completed' },
        'first_buy_cursor_behind'],
      [{ source_next_block: null, caught_up: true, seed_status: 'completed' },
        'first_buy_block_frontier_unavailable'],
    ];
    for (const [coverage, reason] of cases) {
      const db = database(coverage);
      const result = await createRobinhoodBundleFundingCandidateSource({ database: db }).load();
      assert.deepEqual(result, {
        ready: false, reason, completeThroughBlock: null, candidates: [],
      });
      assert.equal(db.calls.length, 1);
    }
  });
});

describe('Robinhood bundle funding workload command', () => {
  it('requires explicit bounded lookbacks and rejects write flags', () => {
    assert.deepEqual(parseArgs(['--lookback-blocks=1000,0,1000,5000']), {
      lookbackBlocks: [0, 1000, 5000], sourceFromBlock: '0',
      statementTimeoutMs: 120_000,
    });
    assert.throws(() => parseArgs([]), /lookback-blocks is required/);
    assert.throws(() => parseArgs(['--lookback-blocks=1', '--apply']), /unknown argument/);
    assert.throws(() => parseArgs(['--lookback-blocks=1,2,3,4,5,6,7,8,9']), /between 1 and 8/);
  });

  it('reports aggregate plans without exposing addresses or ranges', async () => {
    const logs = [];
    const report = await main([], {
      options: { lookbackBlocks: [10, 100], sourceFromBlock: '0', statementTimeoutMs: 5_000 },
      source: { load: async () => ({
        ready: true, completeThroughBlock: '200', liveTokens: '12',
        firstBuyTokens: '10', anchoredTokens: '9', tokensWithoutFirstBuy: '2',
        missingAnchorTokens: '1', anchorCoverageComplete: false,
        candidates: [{ secret: WALLET }],
      }) },
      planner: ({ lookbackBlocks }) => ({
        ruleVersion: 'rh_possible_bundle_v1', lookbackBlocks: String(lookbackBlocks),
        candidateTokens: 2, candidates: [{ walletAddress: WALLET }],
        ranges: [{ fromBlock: '1', toBlock: '2' }], blocksToScan: '2',
      }),
      logger: { log: (line) => logs.push(line) },
    });

    assert.equal(report.mode, 'read-only');
    assert.equal(report.sourceCandidateRows, 1);
    assert.equal(report.liveTokens, '12');
    assert.equal(report.tokensWithoutFirstBuy, '2');
    assert.equal(report.missingAnchorTokens, '1');
    assert.deepEqual(report.plans.map(({ lookbackBlocks }) => lookbackBlocks), ['10', '100']);
    assert.equal(JSON.stringify(report).includes(WALLET), false);
    assert.equal(JSON.stringify(report).includes('fromBlock'), false);
    assert.equal(logs.length, 1);
  });

  it('refuses to plan from an unavailable source', async () => {
    await assert.rejects(main([], {
      options: { lookbackBlocks: [10], sourceFromBlock: '0' },
      source: { load: async () => ({ ready: false, reason: 'first_buy_cursor_behind' }) },
      logger: { log: () => {} },
    }), /first_buy_cursor_behind/);
  });
});
