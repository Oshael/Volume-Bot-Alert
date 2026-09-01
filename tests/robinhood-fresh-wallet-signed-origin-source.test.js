const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodFreshWalletSignedOriginSource,
} = require('../src/services/robinhood-fresh-wallet-signed-origin-source');

const WALLET = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function canonical() {
  return { ruleVersion: 'rh_fresh_signed_v1', source: 'robinhood-live', sourceKind: 'live',
    observedAt: '2026-08-30T12:00:00Z',
    firstBuy: { walletAddress: WALLET, transactionHash: HASH, blockNumber: '120',
      blockHash: HASH, blockTime: '2026-08-30T12:00:00Z', nonce: '5' },
    cutoff: { targetAt: '2026-08-29T12:00:00Z', number: '110', hash: HASH,
      blockTime: '2026-08-29T11:59:59Z' },
    nextBlock: { number: '111', hash: HASH, blockTime: '2026-08-29T12:00:00Z' },
  };
}

function row(overrides = {}) {
  return { origin_block: '100', through_block: '130', first_block_number: '120',
    first_block_hash: HASH, first_block_time: new Date('2026-08-30T12:00:00Z'),
    first_transaction_hash: HASH, first_transaction_index: '4', first_nonce: '0',
    source_stream: 'live', ...overrides };
}

function source(value) {
  const queries = [];
  return { queries, value: createRobinhoodFreshWalletSignedOriginSource({
    canonicalSource: { readCanonicalEvidence: async () => canonical() },
    database: { async query(sql, params) { queries.push([sql, params]); return { rows: value }; } },
  }) };
}

describe('Robinhood FRESH signed-origin PostgreSQL source', () => {
  it('requires coverage through first-buy and materializes origin evidence', async () => {
    const context = source([row()]);
    const evidence = await context.value.readEvidence({ walletAddress: WALLET,
      transactionIndex: '4' });
    assert.equal(evidence.sourceKind, 'live');
    assert.equal(evidence.source, 'robinhood-signed-origin-index');
    assert.equal(evidence.cutoff.nonce, undefined);
    assert.deepEqual(evidence.signedActivity, {
      priorSignedActivity: false, reason: 'no_signed_activity_before_cutoff',
      coverage: { originBlock: '100', throughBlock: '130' },
      origin: { blockNumber: '120', blockHash: HASH,
        blockTime: '2026-08-30T12:00:00.000Z', transactionHash: HASH,
        transactionIndex: '4', nonce: '0', sourceStream: 'live' },
    });
    assert.deepEqual(context.queries[0][1], ['robinhood', WALLET]);
  });

  it('fails closed instead of completing a task outside coverage', async () => {
    for (const rows of [[], [row({ through_block: '119' })],
      [row({ origin_block: '111' })]]) {
      await assert.rejects(() => source(rows).value.readEvidence({ walletAddress: WALLET,
        transactionIndex: '4' }),
      (error) => error.code === 'fresh_signed_origin_unavailable');
    }
  });

  it('does not turn an unobserved nonce predecessor into prior signed activity', async () => {
    await assert.rejects(() => source([row({ first_nonce: '1' })]).value.readEvidence({
      walletAddress: WALLET, transactionIndex: '4',
    }), (error) => error.code === 'fresh_signed_origin_unavailable'
      && error.reason === 'positive_nonce_without_observed_predecessor');
  });
});
