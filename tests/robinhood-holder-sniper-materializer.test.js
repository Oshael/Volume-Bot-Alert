const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildSniperSnapshot,
  createRobinhoodHolderSniperMaterializer,
  SNIPER_HIGH_CONFIDENCE_RULE,
} = require('../src/services/robinhood-holder-sniper-materializer');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'6'.repeat(40)}`;
const HASH = `0x${'2'.repeat(64)}`;
const TX = `0x${'3'.repeat(64)}`;
const WALLET_A = `0x${'4'.repeat(40)}`;
const WALLET_B = `0x${'5'.repeat(40)}`;

function buy(walletAddress, overrides = {}) {
  return {
    walletAddress, transactionHash: TX, actionIndex: '1', transactionIndex: '2',
    blockNumber: '101', blockHash: HASH, blockTime: '2026-08-21T12:00:05Z',
    volumeUsd: '25', evidenceVersion: 'rh_launch_v1', deltaBlocks: '1',
    deltaSeconds: 5, buyerRank: 1, withinLaunchWindow: true, ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    ready: true, tokenAddress: TOKEN,
    frontier: { blockNumber: '200', blockHash: HASH },
    coverage: { historicalFromBlock: '90', completeThroughBlock: '200' },
    window: { maxBlocks: 3, maxSeconds: 90 },
    anchor: {
      transactionHash: TX, actionIndex: '0', transactionIndex: '1',
      blockNumber: '100', blockHash: HASH, blockTime: '2026-08-21T12:00:00Z',
    },
    firstBuys: [buy(WALLET_A), buy(WALLET_B, { volumeUsd: '9.99' })],
    exclusions: [],
    ...overrides,
  };
}

function recurrence(walletAddress, tokenAddress, overrides = {}) {
  return {
    walletAddress, tokenAddress, volumeUsd: '50', anchorReady: true,
    withinOneBlock: true, buyerRank: 1, positionReady: true, ...overrides,
  };
}

describe('Robinhood holder SNIPER materializer', () => {
  it('closes the calibrated high-confidence rule as a versioned policy', () => {
    assert.deepEqual(SNIPER_HIGH_CONFIDENCE_RULE, {
      evidenceVersion: 'rh_sniper_high_v2', maxBlocks: 1, maxBuyerRank: 5,
      minimumNotionalUsd: '50', minimumRecurringLaunches: 3,
    });
    assert.doesNotThrow(() => createRobinhoodHolderSniperMaterializer({
      source: {}, recurrenceSource: {}, classifications: {},
    }));
  });

  it('publishes only top-five first-block buyers with notional and recurrence', () => {
    const snapshot = buildSniperSnapshot(evidence({
      firstBuys: [
        buy(WALLET_A, { volumeUsd: '50.000' }),
        buy(WALLET_B, { volumeUsd: '100', buyerRank: 6 }),
      ],
    }), [
      recurrence(WALLET_A, TOKEN), recurrence(WALLET_A, `0x${'6'.repeat(40)}`),
      recurrence(WALLET_A, `0x${'8'.repeat(40)}`),
      recurrence(WALLET_B, TOKEN), recurrence(WALLET_B, `0x${'7'.repeat(40)}`),
    ], '2026-08-21T13:00:00Z');

    assert.equal(snapshot.classifier, 'sniper');
    assert.deepEqual(snapshot.records.map(({ walletAddress }) => walletAddress), [WALLET_A]);
    assert.equal(snapshot.records[0].confidence, 'high');
    assert.deepEqual(snapshot.records[0].evidence.rule, {
      evidenceVersion: 'rh_sniper_high_v2', maxBlocks: 1, maxBuyerRank: 5,
      minimumNotionalUsd: '50', minimumRecurringLaunches: 3,
    });
    assert.deepEqual(snapshot.records[0].evidence.recurrence, {
      source: 'robinhood_wallet_token_first_buys',
      qualifyingLaunches: 3, completeThroughBlock: '200',
    });
  });

  it('configures the live evidence source to read only top-five buyers', () => {
    let received;
    createRobinhoodHolderSniperMaterializer({
      sourceFactory: (options) => {
        received = options;
        return {};
      },
      recurrenceSource: {}, classifications: {},
    });
    assert.equal(received.firstBuyLimit, 5);
    assert.equal(received.minimumFirstBuyNotionalUsd, '50');
    assert.equal(received.candidateMaxBlocks, 1);
  });

  it('materializes an empty fast-path snapshot without a hydrated anchor', () => {
    const snapshot = buildSniperSnapshot(evidence({
      anchor: null, firstBuys: [],
    }), [], '2026-08-21T13:00:00Z');
    assert.deepEqual(snapshot.records, []);
  });

  it('shares one set-based recurrence read across a bounded token batch', async () => {
    const recurrenceCalls = [];
    const writes = [];
    const materializer = createRobinhoodHolderSniperMaterializer({
      source: { loadLaunchEvidence: async (tokenAddress) => evidence({
        tokenAddress,
        firstBuys: [buy(tokenAddress === TOKEN ? WALLET_A : WALLET_B, {
          volumeUsd: '50',
        })],
      }) },
      recurrenceSource: { loadHighConfidenceRecurrence: async (...args) => {
        recurrenceCalls.push(args);
        return { ready: true, rows: [WALLET_A, WALLET_B].flatMap((wallet) => [
          recurrence(wallet, TOKEN), recurrence(wallet, TOKEN_B),
          recurrence(wallet, `0x${'8'.repeat(40)}`),
        ]) };
      } },
      classifications: { replaceClassifierSnapshot: async (snapshot) => {
        writes.push(snapshot.tokenAddress);
        return { status: 'published', records: snapshot.records.length };
      } },
    });

    assert.deepEqual(await materializer.materializeTokens([TOKEN, TOKEN_B], {
      concurrency: 2,
    }), [
      { tokenAddress: TOKEN, status: 'completed', value: { status: 'published', records: 1 } },
      { tokenAddress: TOKEN_B, status: 'completed', value: { status: 'published', records: 1 } },
    ]);
    assert.equal(recurrenceCalls.length, 1);
    assert.deepEqual(recurrenceCalls[0][0], [WALLET_A, WALLET_B]);
    assert.deepEqual(recurrenceCalls[0][2], {
      minimumNotionalUsd: '50', maxBuyerRank: 5,
    });
    assert.deepEqual(writes.sort(), [TOKEN, TOKEN_B].sort());
  });

  it('contains a token-local evidence failure inside the set-based batch', async () => {
    const materializer = createRobinhoodHolderSniperMaterializer({
      source: { loadLaunchEvidence: async (tokenAddress) => {
        if (tokenAddress === TOKEN_B) throw new Error('broken token');
        return evidence({ tokenAddress, firstBuys: [] });
      } },
      recurrenceSource: { loadHighConfidenceRecurrence: async () => ({
        ready: true, rows: [],
      }) },
      classifications: { replaceClassifierSnapshot: async () => ({
        status: 'published', records: 0,
      }) },
    });

    const outcomes = await materializer.materializeTokens([TOKEN, TOKEN_B], {
      concurrency: 2,
    });
    assert.equal(outcomes[0].status, 'completed');
    assert.equal(outcomes[1].status, 'failed');
    assert.match(outcomes[1].error.message, /broken token/);
  });

  it('keeps one-off, late, low-notional and excluded candidates internal', () => {
    const snapshot = buildSniperSnapshot(evidence({
      firstBuys: [
        buy(WALLET_A),
        buy(WALLET_B, { volumeUsd: '500', deltaBlocks: '2' }),
      ],
      exclusions: [{ walletAddress: WALLET_B, reason: 'infrastructure_cex' }],
    }), [
      recurrence(WALLET_A, TOKEN),
      recurrence(WALLET_A, `0x${'8'.repeat(40)}`, { buyerRank: 6 }),
    ], '2026-08-21T13:00:00Z');

    assert.deepEqual(snapshot.records, []);
  });

  it('defers without touching classification state when launch evidence is unavailable', async () => {
    let writes = 0;
    const materializer = createRobinhoodHolderSniperMaterializer({
      source: { loadLaunchEvidence: async () => ({
        ready: false, reason: 'swap_seed_not_complete',
      }) },
      recurrenceSource: { loadHighConfidenceRecurrence: async () => {
        throw new Error('must not read recurrence');
      } },
      classifications: { replaceClassifierSnapshot: async () => { writes += 1; } },
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'swap_seed_not_complete', records: 0,
    });
    assert.equal(writes, 0);
  });

  it('defers when the canonical recurrence projection is behind', async () => {
    let writes = 0;
    const materializer = createRobinhoodHolderSniperMaterializer({
      source: { loadLaunchEvidence: async () => evidence({
        firstBuys: [buy(WALLET_A, { volumeUsd: '50' })],
      }) },
      recurrenceSource: { loadHighConfidenceRecurrence: async () => ({
        ready: false, reason: 'first_buy_projection_behind',
      }) },
      classifications: { replaceClassifierSnapshot: async () => { writes += 1; } },
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'first_buy_projection_behind', records: 0,
    });
    assert.equal(writes, 0);
  });
});
